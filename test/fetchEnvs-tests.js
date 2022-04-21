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
const FetchEnvs = require('../lib/FetchEnvs');
const fs = require('fs-extra');


const krm = {
  _apiVersion: 'deploy.razee.io/v1alpha2',
  _kind: 'MustacheTemplate',
  async request(reqOpt) {
    const ref = {
      apiVersion: reqOpt.uri.apiVersion,
      kind: reqOpt.uri.kind,
      name: reqOpt.uri.name,
      namespace: reqOpt.uri.namespace,
      labelSelector: reqOpt?.qs?.labelSelector
    };

    const res = await kubeGetResource(ref);
    return res;
  },
  async get(name, namespace) {
    const ref = this.uri({ name, namespace });

    return await kubeGetResource(ref);
  },
  uri(options) {
    return { ...options, apiVersion: this._apiVersion, kind: this._kind, };
  }
};

const controllerObject = {
  data: {
    type: 'ADDED',
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
  },
  kubeResourceMeta: krm,
  kubeClass: {
    getKubeResourceMeta: (apiVersion, kind) => {
      const newKRM = { ...krm };
      newKRM._apiVersion = apiVersion;
      newKRM._kind = kind;
      return newKRM;
    }
  },
};

const altPathControllerObject = {
  data: {
    type: 'ADDED',
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'FeatureFlagSetLD',
      metadata: {
        name: 'rd-test',
        namespace: 'razeedeploy',
      },
      spec: {
        identityRef: {
          envFrom: [],
          env: []
        }
      }
    }
  },
  kubeResourceMeta: krm,
  kubeClass: {
    getKubeResourceMeta: (apiVersion, kind) => {
      const newKRM = { ...krm };
      newKRM._apiVersion = apiVersion;
      newKRM._kind = kind;
      return newKRM;
    }
  },
};

async function kubeGetResource(ref) {
  const kubeData = await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/sampleData.json`);
  const {
    name,
    labelSelector,
    namespace,
    kind,
    apiVersion
  } = ref;
  if (!kubeData[kind]) {
    return;
  }

  let fn = labelSelector ? 'filter' : 'find';
  let lookup = kubeData[kind][fn](obj => {
    let match = true;
    match = (obj.apiVersion === apiVersion && match) ? true : false;
    match = (obj.kind === kind && match) ? true : false;
    match = ((obj.metadata.name === name || labelSelector !== undefined) && match) ? true : false;
    match = (obj.metadata.namespace === namespace && match) ? true : false;
    if (labelSelector) {
      const objLabels = obj.metadata.labels ?? {};
      labelSelector.split(',').forEach(label => {
        let [key, value] = label.split('=');
        match = (objLabels[key] === value && match) ? true : false;
      });
    }
    return match;
  });
  return labelSelector ? { items: lookup } : lookup;
}

describe('fetchEnvs', function () {
  afterEach(function () {
    controllerObject.data.object.spec.envFrom = [];
    controllerObject.data.object.spec.env = [];
    altPathControllerObject.data.object.spec.identityRef.envFrom = [];
    altPathControllerObject.data.object.spec.identityRef.env = [];
  });


  describe('#high level tests', function () {
    it('should print class toString', async function () {
      const fetchEnvs = new FetchEnvs(controllerObject);

      assert.equal(fetchEnvs.toString(), '[object FetchEnvs]', 'should define toString');
    });
    it('should fail to construct class without controllerObject', async function () {
      try {
        new FetchEnvs();
      } catch (error) {
        const errMsg = 'FetchEnvs must have: controller object instance';
        return assert.equal(error.message, errMsg, 'should get error for not passing controller object');
      }
      assert.fail('should not succeeded when not passing controller object');
    });

    it('should fetch empty view when no env set', async function () {
      const fetchEnvs = new FetchEnvs(controllerObject);
      const view = await fetchEnvs.get('spec');

      assert.equal(Object.keys(view).length, Object.keys({}).length, 'should be empty');
    });
  });

  // #get() envFrom
  describe('#get() envFrom', function () {
    it('envFrom_scenarios.json/scenario1: simple single ConfigMap ref', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario1;
      const fetchEnvs = new FetchEnvs(controllerObject);
      const view = await fetchEnvs.get('spec');

      const expectedJson = {
        'array': '[1, 2, 3]',
        'json': '{\n  "grpc": {\n    "secure_server": true,\n    "secure_server_only": false,\n    "secure_port": 55053,\n    "strict_mtls": false\n  },\n  "metrics_tls_enabled": true,\n  "metrics_strict_mtls": false\n}',
        'number': '1',
        'string': 'hello',
        'other': 'data'
      };
      assert.deepEqual(view, expectedJson, 'should fetch config as expected');
    });
    it('envFrom_scenarios.json/scenario2: simple single Secret ref', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario2;
      const fetchEnvs = new FetchEnvs(controllerObject);
      const view = await fetchEnvs.get('spec');

      const expectedJson = {
        'array': '[1, 3, 5]',
        'json': '{\n  "grpc": {\n    "secure_server": true,\n    "secure_server_only": false,\n    "secure_port": 55053,\n    "strict_mtls": false\n  },\n  "metrics_tls_enabled": true,\n  "metrics_strict_mtls": false\n}',
        'number': '1',
        'string': 'admin'
      };
      assert.deepEqual(view, expectedJson, 'should fetch config as expected');
    });
    it('envFrom_scenarios.json/scenario3: simple single CustomDataStore ref', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario3;
      const fetchEnvs = new FetchEnvs(controllerObject);
      const view = await fetchEnvs.get('spec');

      const expectedJson = {
        'array': '[2, 4, 6]',
        'json': '{\n  "grpc": {\n    "secure_server": true,\n    "secure_server_only": false,\n    "secure_port": 55053,\n    "strict_mtls": false\n  },\n  "metrics_tls_enabled": true,\n  "metrics_strict_mtls": false\n}',
        'number': '1',
        'string': 'jar'
      };
      assert.deepEqual(view, expectedJson, 'should fetch config as expected');
    });
    it('envFrom_scenarios.json/scenario4: unknown ref', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario4;
      const fetchEnvs = new FetchEnvs(controllerObject);
      try {
        await fetchEnvs.get('spec');
      } catch (error) {
        const errMsg = 'oneOf configMapRef, secretMapRef, genericMapRef must be defined. Got: {"unknownMapRef":{"namespace":"razeedeploy","name":"default-values-multiple-types"}}';
        return assert.equal(error.message, errMsg, 'should get error for unknown ref');
      }
      assert.fail('should not succeeded when unknown ref is defined');
    });
    it('envFrom_scenarios.json/scenario5: mupliple configMapRefs with comman keys', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario5;
      const fetchEnvs = new FetchEnvs(controllerObject);
      const view = await fetchEnvs.get('spec');

      const expectedJson = {
        'array': '[4, 5, 6]',
        'json': '{\n  "grpc": {\n    "secure_port": 80808,\n    "strict_mtls": true\n  },\n  "metrics_strict_mtls": true\n}',
        'number': '2',
        'string': 'goodbye',
        'other': 'data'
      };
      assert.deepEqual(view, expectedJson, 'should fetch config as expected');
    });
    it('envFrom_scenarios.json/scenario6: same as scenario5 but backwards to show that order matters', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario6;
      const fetchEnvs = new FetchEnvs(controllerObject);
      const view = await fetchEnvs.get('spec');

      const expectedJson = {
        'array': '[1, 2, 3]',
        'json': '{\n  "grpc": {\n    "secure_server": true,\n    "secure_server_only": false,\n    "secure_port": 55053,\n    "strict_mtls": false\n  },\n  "metrics_tls_enabled": true,\n  "metrics_strict_mtls": false\n}',
        'number': '1',
        'string': 'hello',
        'other': 'data'
      };
      assert.deepEqual(view, expectedJson, 'should fetch config as expected');
    });
    it('envFrom_scenarios.json/scenario7: optional unknown configmap returns empty view', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario7;
      const fetchEnvs = new FetchEnvs(controllerObject);
      const view = await fetchEnvs.get('spec');

      assert.deepEqual(view, {}, 'should fetch config as expected');
    });
    it('envFrom_scenarios.json/scenario8: non-optional unknown configmap returns error', async function () {
      controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom_scenarios.json`)).scenario8;
      const fetchEnvs = new FetchEnvs(controllerObject);
      try {
        await fetchEnvs.get('spec');
      } catch (error) {
        const errMsg = 'failed to get envFrom: {"configMapRef":{"namespace":"razeedeploy","name":"unknown-configmap"}}. make sure your data exists in the correct location and is in the expected format.';
        return assert.equal(error.message, errMsg, 'should get error for not found ref');
      }
      assert.fail('should not succeeded when not found ref is defined');
    });

    // #get() env
    describe('#get() env', function () {
      it('env_scenarios.json/scenario1: simple single ConfigMap ref', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario1;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        assert.strictEqual(view.string_env, 'hello', 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario2: simple ConfigMap refs with type', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario2;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');


        assert.strictEqual(view.number_env, 5, 'should fetch config as expected');
        assert.deepEqual(view.json_env, { 'api.test.com': [{ 'path': '/v1/two', 'service': 'service-two', 'port': '80' }] }, 'should fetch config as expected');
        assert.deepEqual(view.array_env, [1, 2, 3], 'should fetch config as expected');
        assert.strictEqual(view.bool_env, true, 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario3: overrideStrategy merge', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario3;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        const expectedJson = {
          grpc: {
            secure_server: true,
            secure_server_only: false,
            secure_port: 80808,
            strict_mtls: true
          },
          metrics_tls_enabled: true,
          metrics_strict_mtls: true
        };
        assert.deepEqual(view.json_env, expectedJson, 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario4: scenario3 but reversed to show order matters', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario4;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        const expectedJson = {
          grpc: {
            secure_server: true,
            secure_server_only: false,
            secure_port: 55053,
            strict_mtls: false
          },
          metrics_tls_enabled: true,
          metrics_strict_mtls: false
        };
        assert.deepEqual(view.json_env, expectedJson, 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario5: matchLabels + overrideStrategy merge', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario5;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        const expectedJson = {
          'api.test.com': [
            { path: '/v1/one', service: 'service-one', port: '80' },
            { path: '/v1/two', service: 'service-two', port: '80' }
          ]
        };
        assert.deepEqual(view.json_env, expectedJson, 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario6: failed to find required key', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario6;
        const fetchEnvs = new FetchEnvs(controllerObject);

        try {
          await fetchEnvs.get('spec');
        } catch (error) {
          const errMsg = 'failed to get env: {"name":"number_env","valueFrom":{"configMapKeyRef":{"namespace":"razeedeploy","name":"default-values-multiple-types","key":"unknown_key"}}}. make sure your data exists in the correct location and is in the expected format.';
          return assert.equal(error.message, errMsg, 'should get error for unknown key');
        }
        assert.fail('should not succeeded when unknown key is defined');
      });
      it('env_scenarios.json/scenario7: unknown ref', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario7;
        const fetchEnvs = new FetchEnvs(controllerObject);

        try {
          await fetchEnvs.get('spec');
        } catch (error) {
          const errMsg = 'oneOf genericKeyRef, configMapKeyRef, secretKeyRef must be defined. Got: {"name":"number_env","valueFrom":{"unknownKeyRef":{"namespace":"razeedeploy","name":"default-values-multiple-types","key":"number"}}}';
          return assert.equal(error.message, errMsg, 'should get error for unknown ref');
        }
        assert.fail('should not succeeded when unknown ref is defined');
      });
      it('env_scenarios.json/scenario8: optional key not found', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario8;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        assert.deepEqual(view, {}, 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario9: optional key not found, defaultValue and type set', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario9;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        assert.strictEqual(view.number_env, 5, 'should fetch config as expected');
        assert.strictEqual(view.bool_env, false, 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario10: generickeyRef', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario10;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        assert.deepEqual(view.json_env, [2, 4, 6], 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario11: plain value, no ref', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario11;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        assert.deepEqual(view.string_env, 'my value', 'should fetch config as expected');
      });
      it('env_scenarios.json/scenario12: supposed to be json, but empty', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario12;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        assert.deepEqual(view.json_env, {}, 'should return empty object instead of error');
      });
      it('env_scenarios.json/scenario13: malformed json', async function () {
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/env_scenarios.json`)).scenario13;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const { name: refName } = controllerObject.data.object.spec.env[0].valueFrom.configMapKeyRef
        const malformedValue = "{\"some\": \"value"

        try {
          view = await fetchEnvs.get('spec');
          throw new Error("Expected an error, but no error was thrown")
        } catch (error) {
          assert.include(error.message, refName)
          assert.include(error.message, malformedValue)
          assert.include(error.message, "Unexpected end of JSON input")
        }
      });
    });

    // #get() envFrom + env
    describe('#get() envFrom + env', function () {
      it('envFrom+env_scenarios.json/scenario1: single ConfigMap with 1 secret key override', async function () {
        controllerObject.data.object.spec.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom+env_scenarios.json`)).scenario1.envFrom;
        controllerObject.data.object.spec.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom+env_scenarios.json`)).scenario1.env;
        const fetchEnvs = new FetchEnvs(controllerObject);
        const view = await fetchEnvs.get('spec');

        const expectedJson = {
          'array': '[1, 2, 3]',
          'json': '{\n  "grpc": {\n    "secure_server": true,\n    "secure_server_only": false,\n    "secure_port": 55053,\n    "strict_mtls": false\n  },\n  "metrics_tls_enabled": true,\n  "metrics_strict_mtls": false\n}',
          'number': '1',
          'string': 'password',
          'other': 'data'
        };
        assert.deepEqual(view, expectedJson, 'should fetch config as expected');
      });
    });

    // #get() envFrom + env for Alt Path
    describe('#get() envFrom + env for Alternate Path', function () {
      it('envFrom+env_scenarios.json/scenario1: single ConfigMap with 1 secret key override', async function () {
        altPathControllerObject.data.object.spec.identityRef.envFrom = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom+env_scenarios.json`)).scenario1.envFrom;
        altPathControllerObject.data.object.spec.identityRef.env = (await fs.readJSON(`${__dirname}/fetchEnvs-test-scenarios/envFrom+env_scenarios.json`)).scenario1.env;
        const fetchEnvs = new FetchEnvs(altPathControllerObject);
        const view = await fetchEnvs.get('spec.identityRef');

        const expectedJson = {
          'array': '[1, 2, 3]',
          'json': '{\n  "grpc": {\n    "secure_server": true,\n    "secure_server_only": false,\n    "secure_port": 55053,\n    "strict_mtls": false\n  },\n  "metrics_tls_enabled": true,\n  "metrics_strict_mtls": false\n}',
          'number': '1',
          'string': 'password',
          'other': 'data'
        };
        assert.deepEqual(view, expectedJson, 'should fetch config as expected');
      });
    });
  });
});
