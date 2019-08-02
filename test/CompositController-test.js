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
const nock = require('nock');
const fs = require('fs-extra');

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

  describe('#execute()', function () {
    it('should not execute when lock-cluster true', async function () {
      sandbox.stub(fs, 'pathExists').returns(true);
      sandbox.stub(fs, 'readFile').returns('true');
      let cc = new CompositeController(params).execute();
      // now handle stubbing all the patch status stuff
      // and figure out a way to confirm the execute stopped after cluster locked true
    });
  });

  // describe('#test()', function () {
  //   it('should work', function () {
  //     sandbox.stub(BaseController.prototype, 'name').get(() => 'fakeName');
  //     let cc = new CompositeController({ eventData: { object: { metadata: { name: 'realName' } } } });
  //     console.log(cc.name);
  //     // assert.equal('1', '1', 'should');
  //   });
  // });

});
