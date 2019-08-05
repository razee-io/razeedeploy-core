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
// const clone = require('clone');

const { KubeResourceMeta, KubeClass } = require('@razee/kubernetes-util');
const kubeApiConfig = { baseUrl: 'http://localhost' };
var params;

const CompositeController = require('../lib/CompositeController');

describe('CompositeController', function () {

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

  describe('#applyChild() success', function () {

    it('should apply single child properly', async function () {
      sandbox.stub(CompositeController.prototype, 'apply').resolves({ statusCode: 200, body: 'test assumes applied successfully' });
      sandbox.stub(CompositeController.prototype, 'ensureExists').resolves({ statusCode: 200, body: 'test assumes ensureExists applied successfully' });
      sandbox.stub(CompositeController.prototype, 'addChildren').returns({ statusCode: 200, body: 'test assumes addChildren successful' });
      sandbox.stub(params.kubeClass, 'getKubeResourceMeta').returns(params.kubeResourceMeta);

      let cc = new CompositeController(params);
      let applyChild = await cc.applyChild(fs.readJsonSync('./test/sample-data/Child_RemoteResource.json'));

      assert.deepEqual(applyChild, { statusCode: 200, body: 'test assumes applied successfully' }, 'should get test string back from execute');
    });

    it('should apply single child properly when no namespace provided', async function () {
      sandbox.stub(CompositeController.prototype, 'apply').resolves({ statusCode: 200, body: 'test assumes applied successfully' });
      sandbox.stub(CompositeController.prototype, 'ensureExists').resolves({ statusCode: 200, body: 'test assumes ensureExists applied successfully' });
      sandbox.stub(CompositeController.prototype, 'addChildren').returns({ statusCode: 200, body: 'test assumes addChildren successful' });
      sandbox.stub(params.kubeClass, 'getKubeResourceMeta').returns(params.kubeResourceMeta);

      let cc = new CompositeController(params);
      let childFile = fs.readJsonSync('./test/sample-data/Child_RemoteResource_NoNs.json');
      assert.notExists(childFile.metadata.namespace, 'should not have namespace yet');
      let applyChild = await cc.applyChild(childFile);
      assert.equal(childFile.metadata.namespace, 'armada', 'should have namespace armada');
      assert.deepEqual(applyChild, { statusCode: 200, body: 'test assumes applied successfully' }, 'should get test string back from execute');
    });

    it('should apply list child properly', async function () {
      let apply = sandbox.stub(CompositeController.prototype, 'apply')
        .onCall(0).resolves({ statusCode: 200, body: 'test apply response one' })
        .onCall(1).resolves({ statusCode: 200, body: 'test apply response two' });
      sandbox.stub(CompositeController.prototype, 'ensureExists').resolves({ statusCode: 200, body: 'test assumes ensureExists applied successfully' });
      sandbox.stub(CompositeController.prototype, 'addChildren').returns({ statusCode: 200, body: 'test assumes addChildren successful' });
      sandbox.stub(params.kubeClass, 'getKubeResourceMeta').returns(params.kubeResourceMeta);

      let cc = new CompositeController(params);
      let applyChild = await cc.applyChild(fs.readJsonSync('./test/sample-data/Child_ListWithRemoteResource.json'));

      assert.isTrue(apply.calledTwice, 'should call apply twice. once per list item');
      assert.deepEqual(applyChild, { statusCode: 200, body: 'test apply response one' }, 'should get first test string back from execute');
    });

  }); // #applyChild() success

  describe('#applyChild() failure', function () {

    it('should return failure status code for single child properly', async function () {
      sandbox.stub(CompositeController.prototype, 'apply').rejects({ statusCode: 400, body: 'test is sending back an error' });
      sandbox.stub(CompositeController.prototype, 'ensureExists').rejects({ statusCode: 400, body: 'test is sending back an error' });
      let addChildren = sandbox.stub(CompositeController.prototype, 'addChildren').returns({ statusCode: 200, body: 'test assumes addChildren successful' });
      sandbox.stub(params.kubeClass, 'getKubeResourceMeta').returns(params.kubeResourceMeta);

      let cc = new CompositeController(params);
      let applyChild = await cc.applyChild(fs.readJsonSync('./test/sample-data/Child_RemoteResource.json'));

      assert.isTrue(addChildren.notCalled, 'should not get to addChildren');
      assert.deepEqual(applyChild, { statusCode: 400, body: 'test is sending back an error' }, 'should return non 200 status code to caller');
    });

    it('should return failure status code for 404 child properly', async function () {
      let apply = sandbox.stub(CompositeController.prototype, 'apply').rejects({ statusCode: 400, body: 'test is sending back an error' });
      sandbox.stub(CompositeController.prototype, 'ensureExists').rejects({ statusCode: 400, body: 'test is sending back an error' });
      let addChildren = sandbox.stub(CompositeController.prototype, 'addChildren').returns({ statusCode: 200, body: 'test assumes addChildren successful' });
      sandbox.stub(params.kubeClass, 'getKubeResourceMeta').returns(undefined);

      let cc = new CompositeController(params);
      let applyChild = await cc.applyChild({ apiVersion: 'v1Crazy1', kind: 'imafake', metadata: { namespace: 'fakeNS' } });

      assert.isTrue(apply.notCalled, 'should not get to apply');
      assert.isTrue(addChildren.notCalled, 'should not get to addChildren');
      assert.equal(applyChild.statusCode, 404, 'should return non 404 status code to caller');
      assert.equal(applyChild.body.message, 'Unable to find kubernetes resource matching: v1Crazy1/imafake', 'should return non 404 status code to caller');
    });

    it('should return failure status code for 404 child, with no namespace, properly', async function () {
      let apply = sandbox.stub(CompositeController.prototype, 'apply').rejects({ statusCode: 400, body: 'test is sending back an error' });
      sandbox.stub(CompositeController.prototype, 'ensureExists').rejects({ statusCode: 400, body: 'test is sending back an error' });
      let addChildren = sandbox.stub(CompositeController.prototype, 'addChildren').returns({ statusCode: 200, body: 'test assumes addChildren successful' });
      sandbox.stub(params.kubeClass, 'getKubeResourceMeta').returns(undefined);

      let cc = new CompositeController(params);
      let applyChild = await cc.applyChild({ apiVersion: 'v1Crazy1', kind: 'imafake' });

      assert.isTrue(apply.notCalled, 'should not get to apply');
      assert.isTrue(addChildren.notCalled, 'should not get to addChildren');
      assert.equal(applyChild.statusCode, 404, 'should return non 404 status code to caller');
      assert.equal(applyChild.body.message, 'Unable to find kubernetes resource matching: v1Crazy1/imafake', 'should return non 404 status code to caller');
    });

    it('should return failure status code for list child properly', async function () {
      let apply = sandbox.stub(CompositeController.prototype, 'apply')
        .onCall(0).resolves({ statusCode: 200, body: 'test assumes applied successfully' })
        .onCall(1).rejects({ statusCode: 400, body: 'test is sending back an error' });
      sandbox.stub(CompositeController.prototype, 'ensureExists').rejects({ statusCode: 400, body: 'test is sending back an error' });
      let addChildren = sandbox.stub(CompositeController.prototype, 'addChildren').returns({ statusCode: 200, body: 'test assumes addChildren successful' });
      sandbox.stub(params.kubeClass, 'getKubeResourceMeta').returns(params.kubeResourceMeta);

      let cc = new CompositeController(params);
      let applyChild = await cc.applyChild(fs.readJsonSync('./test/sample-data/Child_ListWithRemoteResource.json'));

      assert.isTrue(apply.calledTwice, 'should call apply twice. once per list item');
      assert.isTrue(addChildren.calledOnce, 'should not get to addChildren for second apply');
      assert.deepEqual(applyChild, { statusCode: 400, body: 'test is sending back an error' }, 'should return non 200 status code to caller');
    });

  }); // #applyChild() failure

});
