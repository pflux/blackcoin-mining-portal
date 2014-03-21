var redis = require('redis');
var async = require('async');

var os = require('os');
var Stratum = require('stratum-pool');


module.exports = function(logger, portalConfig, poolConfigs){

    var _this = this;

    var redisClients = [];

    var algoMultipliers = {
        'scrypt': Math.pow(2, 16),
        'sha256': Math.pow(2, 32)
    };

    Object.keys(poolConfigs).forEach(function(coin){
        var poolConfig = poolConfigs[coin];
        var internalConfig = poolConfig.shareProcessing.internal;
        var redisConfig = internalConfig.redis;

        for (var i = 0; i < redisClients.length; i++){
            var client = redisClients[i];
            if (client.client.port === redisConfig.port && client.client.host === redisConfig.host){
                client.coins.push(coin);
                return;
            }
        }
        redisClients.push({
            coins: [coin],
            client: redis.createClient(redisConfig.port, redisConfig.host)
        });
    });


    this.stats = {};
    this.poolConfigs = poolConfigs;


    this.getMinerStats = function(address, cback){

        var minerStats = {};



        async.each(redisClients[0].coins, function(coin, cb){


            var daemon = new Stratum.daemon.interface([_this.poolConfigs[coin].shareProcessing.internal.daemon]);


            minerStats[coin] = {};
            var client = redisClients[0].client;
            
            async.waterfall([

                /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
                   blocks. */
                function(callback){

                    client.smembers(coin + '_blocksPending', function(error, results){

                        if (error){
                            paymentLogger.error('redis', 'Could get blocks from redis ' + JSON.stringify(error));
                            callback('done - redis error for getting blocks');
                            return;
                        }
                        if (results.length === 0){
                            callback('done - no pending blocks in redis');
                            return;
                        }

                        var rounds = results.map(function(r){
                            var details = r.split(':');
                            return {txHash: details[0], height: details[1], reward: details[2], amount:r.amount};
                        });

                        callback(null, rounds);
                    });
                },

                /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
                It also adds the block reward amount to the round object - which the daemon gives also gives us. */
                function(rounds, callback){

                    var batchRPCcommand = rounds.map(function(r){
                        return ['gettransaction', [r.txHash]];
                    });

                    daemon.batchCmd(batchRPCcommand, function(error, txDetails){

                        if (error || !txDetails){
                            callback('done - daemon rpc error with batch gettransactions ' + JSON.stringify(error));
                            return;
                        }

                        txDetails = txDetails.filter(function(tx){
                            if (tx.error || !tx.result){
                                console.log('error with requesting transaction from block daemon: ' + JSON.stringify(t));
                                return false;
                            }
                            return true;
                        });

                        var orphanedRounds = [];
                        var confirmedRounds = [];
                        var pendingRounds = [];
                        //Rounds that are not confirmed yet are removed from the round array
                        //We also get reward amount for each block from daemon reply
                        rounds.forEach(function(r){

                            var tx = txDetails.filter(function(tx){return tx.result.txid === r.txHash})[0];

                            if (!tx){
                                console.log('daemon did not give us back a transaction that we asked for: ' + r.txHash);
                                return;
                            }


                            r.category = tx.result.details[0].category;

                            if (r.category === 'orphan'){
                                orphanedRounds.push(r);

                            }
                            else if (r.category === 'generate'){
                                r.amount = tx.result.amount;
                                r.magnitude = r.reward / r.amount;
                                confirmedRounds.push(r);
                            }
                            else if (r.category === 'immature'){
                                r.amount = tx.result.amount;
                                r.magnitude = r.reward / r.amount;
                                pendingRounds.push(r);
                            }

                        });

                        if (orphanedRounds.length === 0 && confirmedRounds.length === 0 && pendingRounds.length === 0){
                            callback('done - no confirmed, pending or orhpaned rounds');
                        }
                        else{
                            callback(null, confirmedRounds, pendingRounds, orphanedRounds);
                        }
                    });
                },

                /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
                   amount owned to each miner for each round. */
                function(confirmedRounds, pendingRounds, orphanedRounds, callback){


                    var rounds = [];
                    for (var i = 0; i < orphanedRounds.length; i++) rounds.push(orphanedRounds[i]);
                    for (var i = 0; i < confirmedRounds.length; i++) rounds.push(confirmedRounds[i]);
                    for (var i = 0; i < pendingRounds.length; i++) rounds.push(pendingRounds[i]);

                    var shares = [];


                    var shareLookups = rounds.map(function(r){
                        return ['hgetall', coin + '_shares:round' + r.height]
                    });

                    client.multi(shareLookups).exec(function(error, allWorkerShares){
                        if (error){
                            callback('done - redis error with multi get rounds share')
                            return;
                        }


                        // Iterate through the beginning of the share results which are for the orphaned rounds
                        var orphanMergeCommands = []
                        for (var i = 0; i < orphanedRounds.length; i++){
                            var workerShares = allWorkerShares[i];
                            Object.keys(workerShares).forEach(function(worker){
                                orphanMergeCommands.push(['hincrby', coin + '_shares:roundCurrent', worker, workerShares[worker]]);
                            });
                            orphanMergeCommands.push([]);
                        }

                        // Iterate through the rest of the share results which are for the worker rewards
                        var workerRewards = {};
                        for (var i = orphanedRounds.length; i < allWorkerShares.length; i++){

                            var round = rounds[i];
                            var workerShares = allWorkerShares[i];

                            var reward = round.reward * (1 - _this.poolConfigs[coin].shareProcessing.internal.feePercent);

                            var totalShares = Object.keys(workerShares).reduce(function(p, c){
                                return p + parseInt(workerShares[c])
                            }, 0);


                            for (var worker in workerShares){
                                var percent = parseInt(workerShares[worker]) / totalShares;
                                var workerRewardTotal = Math.floor(reward * percent);
                                if (!(worker in workerRewards)) workerRewards[worker] = 0;
                                workerRewards[worker] += workerRewardTotal;
                            }
                        }

                        // Iterate through the rest of the share results which are for the worker rewards
                        var pendingRewards = {};
                        for (var i = (orphanedRounds.length + confirmedRounds.length); i < allWorkerShares.length; i++){

                            var round = rounds[i];
                            var workerShares = allWorkerShares[i];

                            var reward = round.reward * (1 - _this.poolConfigs[coin].shareProcessing.internal.feePercent);

                            var totalShares = Object.keys(workerShares).reduce(function(p, c){
                                return p + parseInt(workerShares[c])
                            }, 0);


                            for (var worker in workerShares){
                                var percent = parseInt(workerShares[worker]) / totalShares;
                                var workerRewardTotal = Math.floor(reward * percent);
                                if (!(worker in workerRewards)) workerRewards[worker] = 0;
                                pendingRewards[worker] += workerRewardTotal;
                            }
                        }


                        //this calculates profit if you wanna see it
                        /*
                        var workerTotalRewards = Object.keys(workerRewards).reduce(function(p, c){
                            return p + workerRewards[c];
                        }, 0);

                        var poolTotalRewards = rounds.reduce(function(p, c){
                            return p + c.amount * c.magnitude;
                        }, 0);

                        console.log(workerRewards);
                        console.log('pool profit percent' + ((poolTotalRewards - workerTotalRewards) / poolTotalRewards));
                        */

                        callback(null, rounds, workerRewards, pendingRewards, orphanMergeCommands);
                    });
                },

                /* Does a batch call to redis to get worker existing balances from coin_balances*/
                function(rounds, workerRewards, pendingRewards, orphanMergeCommands, callback){

                    var confirmedWorkers = Object.keys(workerRewards);
                    var pendingWorkers = Object.keys(pendingRewards);

                    client.hmget([coin + '_balances'].concat([address]), function(error, results){
                        if (error){
                            callback('done - redis error with multi get balances');
                            return;
                        }


                        var workerBalances = {};

                        for (var i = 0; i < 1; i++){
                            workerBalances[address] = parseInt(results[i]) || 0;
                        }


                        callback(null, rounds, workerRewards, pendingRewards, workerBalances, orphanMergeCommands);
                    });

                },

            ], function(err, rounds, workerRewards, pendingRewards, workerBalances) {

                minerStats[coin].rounds = rounds;
                minerStats[coin].rewards = workerRewards;
                minerStats[coin].pendingRewards = pendingRewards;
                minerStats[coin].balace = workerBalances;

                cb();
            });

        }, function(err){
            _this.stats.minerStats = minerStats;
            cback();
        });
    };


    this.getStats = function(callback){

        var allCoinStats = [];

        async.each(redisClients, function(client, callback){
            var windowTime = (((Date.now() / 1000) - portalConfig.website.hashrateWindow) | 0).toString();
            var redisCommands = [];
            var commandsPerCoin = 4;

            //Clear out old hashrate stats for each coin from redis
            client.coins.forEach(function(coin){
                redisCommands.push(['zremrangebyscore', coin + '_hashrate', '-inf', '(' + windowTime]);
                redisCommands.push(['zrangebyscore', coin + '_hashrate', windowTime, '+inf']);
                redisCommands.push(['hgetall', coin + '_stats']);
                redisCommands.push(['scard', coin + '_blocksPending']);
            });


            client.client.multi(redisCommands).exec(function(err, replies){
                if (err){
                    console.log('error with getting hashrate stats ' + JSON.stringify(err));
                    callback(err);
                }
                else{
                    for(var i = 0; i < replies.length; i += commandsPerCoin){
                        var coinStats = {
                            coinName: client.coins[i / commandsPerCoin | 0],
                            hashrates: replies[i + 1],
                            poolStats: replies[i + 2],
                            poolPendingBlocks: replies[i + 3]
                        };
                        allCoinStats.push(coinStats)

                    }
                    callback();
                }
            });
        }, function(err){
            if (err){
                console.log('error getting all stats' + JSON.stringify(err));
                callback();
                return;
            }

            var portalStats = {
                global:{
                    workers: 0,
                    hashrate: 0
                },
                pools: allCoinStats
            };

            allCoinStats.forEach(function(coinStats){
                coinStats.workers = {};
                coinStats.shares = 0;
                coinStats.hashrates.forEach(function(ins){
                    var parts = ins.split(':');
                    var workerShares = parseInt(parts[0]);
                    coinStats.shares += workerShares;
                    var worker = parts[1];
                    if (worker in coinStats.workers)
                        coinStats.workers[worker] += workerShares
                    else
                        coinStats.workers[worker] = workerShares
                });
                var shareMultiplier = algoMultipliers[poolConfigs[coinStats.coinName].coin.algorithm];
                var hashratePre = shareMultiplier * coinStats.shares / portalConfig.website.hashrateWindow;
                coinStats.hashrate = hashratePre / 1e3 | 0;
                delete coinStats.hashrates;
                portalStats.global.hashrate += coinStats.hashrate;
                portalStats.global.workers += Object.keys(coinStats.workers).length;
            });
            _this.stats = portalStats;
            callback();
        });

    };
};

