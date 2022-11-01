'use strict';
/*
 * Copyright 2022 IBM Corp. All Rights Reserved.
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
const BaseController = require('../lib/BaseController');
const MockKubeResourceMeta = require('../lib/MockKubeResourceMeta');
const reconcileTrue = {
  object: {
    apiVersion: 'deploy.razee.io/v1alpha2',
    kind: 'MustacheTemplate',
    metadata: {
      name: 'rd-test',
      namespace: 'razeedeploy',
      labels: {
        'deploy.razee.io/Reconcile': 'true'
      }
    },
    spec: {
      clusterAuth: { impersonateUser: 'razeedeploy' },
      templateEngine: 'handlebars',
      envFrom: [],
      env: [],
      tempates: [],
      strTemplates: [],
    }
  }
};

const reconcileFalse = {
  object: {
    apiVersion: 'deploy.razee.io/v1alpha2',
    kind: 'MustacheTemplate',
    metadata: {
      name: 'rd-test',
      namespace: 'razeedeploy',
      labels: {
        'deploy.razee.io/Reconcile': 'false'
      }
    },
    spec: {
      clusterAuth: { impersonateUser: 'razeedeploy' },
      templateEngine: 'handlebars',
      envFrom: [],
      env: [],
      tempates: [],
      strTemplates: [],
    }
  }
};

const reconcileDefault = {
  object: {
    apiVersion: 'deploy.razee.io/v1alpha2',
    kind: 'MustacheTemplate',
    metadata: {
      name: 'rd-test',
      namespace: 'razeedeploy',
    },
    spec: {
      clusterAuth: { impersonateUser: 'razeedeploy' },
      templateEngine: 'handlebars',
      envFrom: [],
      env: [],
      tempates: [],
      strTemplates: [],
    }
  }
};

describe('BaseController', function () {
  after(function () {
    delete require.cache[require.resolve('../lib/BaseController')];
  });

  describe('.reconcileDefault', function (){
    it('should return true by default', function () {
      const controller = new BaseController({
        eventData: reconcileDefault,
        kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
      });
      assert.equal(controller.reconcileDefault, 'true');
    });

    it('should return true when deploy.razee.io/Reconcile=true', function () {
      const controller = new BaseController({
        eventData: reconcileTrue,
        kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
      });
      assert.equal(controller.reconcileDefault, 'true');
    });

    it('should return false when deploy.razee.io/Reconcile=false', function () {
      const controller = new BaseController({
        eventData: reconcileFalse,
        kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
      });
      assert.equal(controller.reconcileDefault, 'false');
    });

    it('should return true when reconcileByDefault=true', function () {
      const controller = new BaseController({
        eventData: reconcileDefault,
        options: {reconcileByDefault: true},
        kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
      });
      assert.equal(controller.reconcileDefault, 'true');
    });

    it('should return false when reconcileByDefault=false', function () {
      const controller = new BaseController({
        eventData: reconcileDefault,
        options: {reconcileByDefault: false},
        kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
      });
      assert.equal(controller.reconcileDefault, 'false');
    });


    it('should return true when deploy.razee.io/Reconcile=true, reconcileByDefault=false', function () {
      const controller = new BaseController({
        eventData: reconcileTrue,
        options: {reconcileByDefault: 'false'},
        kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
      });
      assert.equal(controller.reconcileDefault, 'true');
    });

    it('should return true when deploy.razee.io/Reconcile=false, reconcileByDefault=true', function () {
      const controller = new BaseController({
        eventData: reconcileFalse,
        options: {reconcileByDefault: 'true'},
        kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
      });
      assert.equal(controller.reconcileDefault, 'false');
    });


    it('should throw when reconcileByDefault is given a non boolean value', function () {
      assert.throws(() => {
        return new BaseController({
          eventData: reconcileDefault,
          options: {reconcileByDefault: 1},
          kubeResourceMeta: new MockKubeResourceMeta('v1', 'MustacheTemplate', {})
        });
      }, TypeError, /reconcileByDefault must be a boolean value/g);
    });
  });

});


