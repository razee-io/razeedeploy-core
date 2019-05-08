/*
 * Copyright 2019 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var assert = require('chai').assert;

describe('bunyan-api', function () {
  afterEach(function () {});

  after(function () {
    delete require.cache[require.resolve('../lib/bunyan-api')];
  });

  describe('#createLogger()', function () {
    it('should create logger with specified env var LOG_LEVEL=warn (40)', function () {
      process.env.LOG_LEVEL = 'warn';
      var log = require('../lib/bunyan-api').createLogger();
      assert.equal(log.streams[0].level, 40, 'should be at log level warn(40)');
    });

    it('should create logger with log level info(30) when no LOG_LEVEL specified', function () {
      delete process.env.LOG_LEVEL;
      var log = require('../lib/bunyan-api').createLogger();
      assert.equal(log.streams[0].level, 30, 'should be at log level info(30)');
    });

    it('should create logger with log level info(30) when unknown LOG_LEVEL specified', function () {
      process.env.LOG_LEVEL = 'unknownLevelName';
      var log = require('../lib/bunyan-api').createLogger();
      assert.equal(log.streams[0].level, 30, 'should be at log level info(30)');
    });
  });
});
