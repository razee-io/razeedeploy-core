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

const assert = require('chai').assert;
const sandbox = require('sinon').createSandbox();
// const nock = require('nock');
const fs = require('fs-extra');
const clone = require('clone');

const { KubeResourceMeta, KubeClass } = require('@razee/kubernetes-util');
const kubeApiConfig = { baseUrl: 'http://localhost' };
var params;

const CompositeController = require('../lib/CompositeController');

describe('BaseController', function () {

  before(async function () {
    const log = require('../lib/bunyan-api').createLogger('RemoteResource');
    const kc = new KubeClass(kubeApiConfig);
    const resourceMeta = new KubeResourceMeta('/apis/kapitan.razee.io/v1alpha1/', fs.readJsonSync('./test/sample-data/RemoteResource_ApiResource.json'), kubeApiConfig);
    params = {
      kubeResourceMeta: resourceMeta,
      eventData: fs.readJsonSync('./test/sample-data/ADDED_RemoteResource.json'),
      kubeClass: kc,
      logger: log
    };
  });
  after(function () {});
  beforeEach(function () {});
  afterEach(function () {
    // completely restore all fakes created through the sandbox
    sandbox.restore();
  });

  // exmaple stubbing class functions
  // sandbox.stub(CompositeController.prototype, 'name').get(() => 'fakeName');
  // sandbox.stub(CompositeController.prototype, 'execute').callsFake(() => 'fakeExecute');
  // let cc = new CompositeController(params);
  // console.log(cc.name); => fakeName
  // console.log(cc.execute()); => fakeExecute

  describe('#getters', function () {

    it('should return class values', async function () {
      let cc = new CompositeController(params);
      assert.deepEqual(cc.log, params.logger, 'should get proper class value');
      assert.deepEqual(cc.kubeResourceMeta, params.kubeResourceMeta, 'should get proper class value');
      assert.deepEqual(cc.kubeClass, params.kubeClass, 'should get proper class value');
      assert.deepEqual(cc.data, params.eventData, 'should get proper class value');
      cc.updateStatus([{ path: ['child', '-'], status: 'somechild1' }, { path: ['child', '-'], status: { 'childobj': 'somechild2' } }]);
      assert.deepEqual(cc.status, { child: ['somechild1', { 'childobj': 'somechild2' }] }, 'should get proper class value');
      assert.equal(cc.name, 'rr-test', 'should get proper class value');
      assert.equal(cc.namespace, 'armada', 'should get proper class value');
      assert.equal(cc.reconcileDefault, 'true', 'should get proper class value');
      assert.equal(cc.continueExecution, true, 'should get proper class value');
    });

  }); // #getters

  describe('#execute()', function () {

    it('should not execute when passed bad data', async function () {
      sandbox.stub(CompositeController.prototype, 'patchSelf').resolves('miscellaneous return from patchSelf');
      let error = sandbox.stub(CompositeController.prototype, 'errorHandler').callsFake((err) => err.message);

      let badParams = {
        kubeResourceMeta: params.kubeResourceMeta,
        eventData: clone(params.eventData),
        kubeClass: params.kubeClass,
        logger: params.logger
      };

      delete badParams.eventData.type;
      await new CompositeController(badParams).execute();
      assert.equal(error.returnValues[0], 'Unrecognized object recieved from watch event', 'should call errorHandler');


      delete badParams.eventData;
      await new CompositeController(badParams).execute();
      assert.equal(error.returnValues[1], 'Unrecognized object recieved from watch event', 'should call errorHandler');
    });

    it('should not execute when lock-cluster true', async function () {
      sandbox.stub(fs, 'pathExists').returns(true);
      sandbox.stub(fs, 'readFile').returns('true');
      sandbox.stub(CompositeController.prototype, '_patchStatus').resolves('miscellaneous return from _patchStatus');

      let cc = new CompositeController(params);
      let added = sandbox.spy(cc, '_added');
      let exec = await cc.execute();

      assert.isTrue(added.notCalled, 'should not run _added');
      assert.equal(exec, 'miscellaneous return from _patchStatus', 'should get test string back from execute');
    });

  }); // #execute()

});
