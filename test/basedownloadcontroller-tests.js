/**
 * Copyright 2023 IBM Corp. All Rights Reserved.
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
const Controller = require('../lib/MockDownloadController');
const clone = require('clone');
const objectPath = require('object-path');

let kubeData = {};

describe('#BaseDownloadController', async function() {
  afterEach(function() {
    kubeData = {};
  });
  function setupController(eventData) {
    if (Object.keys(kubeData).length === 0) {
      kubeData['ConfigMap'] = [];
    } 

    if (kubeData['RemoteResource'] && kubeData['RemoteResource'][0].metadata.name != eventData.object.metadata.name) {
      kubeData['RemoteResource'].push(clone(eventData).object);
    } else {
      kubeData['RemoteResource'] = [clone(eventData).object];
    }

    const controller = new Controller(clone(eventData), kubeData);
    return controller;
  }

  // the download urls are real, but the requests are stubbed
  const eventData = {
    type: 'ADDED',
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'RemoteResource',
      metadata: {
        name: 'rr',
        namespace: 'basedownloadcontrollertest'
      },
      spec: {
        clusterAuth: {
          impersonateUser: 'razeedeploy'
        },
        backendService: 'generic',
        requests: [
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config.yaml'
            }
          }
        ]
      }
        
    }
  };

  const requestupdate = [
    {
      options: {
        url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config-update.yaml'
      }  
    }
  ];

  const eventData1 = {
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'RemoteResource',
      metadata: {
        name: 'rr',
        namespace: 'basedownloadcontrollertest'
      },
      spec: {
        clusterAuth: {
          impersonateUser: 'razeedeploy'
        },
        backendService: 'generic',
        requests: [
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config.yaml'
            }
          },
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config-update.yaml'
            }
          }
        ]
      }
        
    }
  };

  const eventData2 = {
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'RemoteResource',
      metadata: {
        name: 'rr',
        namespace: 'basedownloadcontrollertest'
      },
      spec: {
        clusterAuth: {
          impersonateUser: 'razeedeploy'
        },
        backendService: 'generic',
        requests: [
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config-falserec.yaml'
            }
          }
        ]
      }
        
    }
  };

  const eventData3 = {
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'RemoteResource',
      metadata: {
        name: 'rr',
        namespace: 'basedownloadcontrollertest'
      },
      spec: {
        clusterAuth: {
          impersonateUser: 'razeedeploy'
        },
        backendService: 'generic',
        requests: [
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/invalid-config.yaml'
            }
          }
        ]
      }
        
    }
  };

  const eventData4 = {
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'RemoteResource',
      metadata: {
        name: 'rr1',
        namespace: 'basedownloadcontrollertest'
      },
      spec: {
        clusterAuth: {
          impersonateUser: 'razeedeploy'
        },
        backendService: 'generic',
        requests: [
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config.yaml'
            }
          }
        ]
      }
        
    }
  };

  const eventData5 = {
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'RemoteResource',
      metadata: {
        name: 'rr',
        namespace: 'basedownloadcontrollertest'
      },
      spec: {
        clusterAuth: {
          impersonateUser: 'razeedeploy'
        },
        backendService: 'generic',
        requests: [
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/invalid-config.yaml'
            },
            optional: true
          },
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config.yaml'
            }
          }
        ]
      }
        
    }
  };

  const eventData6 = {
    type: 'ADDED',
    object: {
      apiVersion: 'deploy.razee.io/v1alpha2',
      kind: 'RemoteResource',
      metadata: {
        name: 'rr',
        namespace: 'basedownloadcontrollertest'
      },
      spec: {
        clusterAuth: {
          impersonateUser: 'razeedeploy'
        },
        backendService: 'generic',
        requests: [
          {
            options: {
              url: 'https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/test-config.yaml',
              headers: {
                Authorization: {
                  valueFrom: {
                    secretKeyRef: {
                      name: 'testtoken',
                      namespace: 'default',
                      key: 'testtoken'
                    }
                  }     
                }
              }
            }
          }
        ]
      }
        
    }
  };

  const childLink = JSON.stringify({
    name: 'config-test',
    namespace: 'basedownloadcontrollertest',
    apiVersion: 'v1',
    kind: 'ConfigMap'
  });

  const childLinkUpdate = JSON.stringify({
    name: 'config-test-update',
    namespace: 'basedownloadcontrollertest',
    apiVersion: 'v1',
    kind: 'ConfigMap'
  });

  const parentLink = JSON.stringify({
    name: 'rr',
    namespace: 'basedownloadcontrollertest',
    apiVersion: 'deploy.razee.io/v1alpha2',
    kind: 'RemoteResource'
  });

  it('Apply single request option', async function () {
    const controller = setupController(eventData);
    await controller.execute();

    assert.equal(Object.keys(kubeData['RemoteResource'][0].status.children)[0], childLink); // child is indicated on parent
    assert.equal(kubeData['ConfigMap'][0].metadata.name, 'config-test'); //child applied
    assert.equal(kubeData['ConfigMap'][0].metadata.annotations['deploy.razee.io.parent'], parentLink); // child has parent link
  });

  it('Update single request option reconcile children', async function () {
    const controller = setupController(eventData);
    await controller.execute();

    // update request option
    const eventDataUpdate = {
      object: clone(kubeData['RemoteResource'][0])
    };
    
    objectPath.set(eventDataUpdate, ['object', 'spec', 'requests'], requestupdate);
    delete eventDataUpdate.object.status['razee-logs'];

    const controller1 = setupController(eventDataUpdate);
    await controller1.execute();

    assert.isNotNull(kubeData['RemoteResource'][0].status.children[childLinkUpdate]); // new child is indicated on parent
    assert.isNull(kubeData['RemoteResource'][0].status.children[childLink]); // old child removed from parent
    assert.equal(kubeData['ConfigMap'][0].metadata.name, 'config-test-update'); // new child applied
    assert.equal(kubeData['ConfigMap'].length, 1); // old child deleted
    assert.equal(kubeData['ConfigMap'][0].metadata.annotations['deploy.razee.io.parent'], parentLink); // new child has parent link
  });

  it('Multiple request options', async function () {
    const controller = setupController(eventData1);
    await controller.execute();

    assert.isNotNull(kubeData['RemoteResource'][0].status.children[childLink]); // child1 is indicated on parent
    assert.isNotNull(kubeData['RemoteResource'][0].status.children[childLinkUpdate]); // child2 is indicated on parent
    assert.equal(kubeData['ConfigMap'][0].metadata.name, 'config-test'); // child1 applied
    assert.equal(kubeData['ConfigMap'][1].metadata.name, 'config-test-update'); // child2 applied
    assert.equal(kubeData['ConfigMap'][0].metadata.annotations['deploy.razee.io.parent'], parentLink); // child1 has parent link
    assert.equal(kubeData['ConfigMap'][1].metadata.annotations['deploy.razee.io.parent'], parentLink); // child2 has parent link
  });

  it('Update single request option reconcile children false', async function () {
    const controller = setupController(eventData2);
    await controller.execute();

    const eventDataUpdate = {
      object: clone(kubeData['RemoteResource'][0])
    };
    
    objectPath.set(eventDataUpdate, ['object', 'spec', 'requests'], requestupdate);
    delete eventDataUpdate.object.status['razee-logs'];

    const controller1 = setupController(eventDataUpdate);
    await controller1.execute();

    assert.isNotNull(kubeData['RemoteResource'][0].status.children[childLinkUpdate]); // new child is indicated on parent
    assert.isNull(kubeData['RemoteResource'][0].status.children[childLink]); // old child removed from parent
    assert.equal(kubeData['ConfigMap'][0].metadata.name, 'config-test'); // new child applied
    assert.equal(kubeData['ConfigMap'][1].metadata.name, 'config-test-update'); // old child still exists
    assert.equal(kubeData['ConfigMap'][1].metadata.annotations['deploy.razee.io.parent'], parentLink); // new child has parent link
    assert.isNull(kubeData['ConfigMap'][0].metadata.annotations['deploy.razee.io.parent']); // old child parent link removed
  });

  it('Invalid file should error', async function () {
    const controller = setupController(eventData3);
    await controller.execute();

    assert.equal(kubeData['ConfigMap'].length, 0); // file should not be applied
    assert(kubeData['RemoteResource'][0].status['razee-logs'].error['22fd971125cc1e46a234866c9c0ac2cfb1acbb0c']); // should have no such file error hash
    assert.equal(kubeData['RemoteResource'][0].status['razee-logs'].error['22fd971125cc1e46a234866c9c0ac2cfb1acbb0c'], 'uri: https://raw.githubusercontent.com/razee-io/razeedeploy-core/master/test/test-configs/invalid-config.yaml, statusCode: undefined, message: ENOENT: no such file or directory, open \'test/test-configs/invalid-config.yaml\'');
  });

  it('Multiple parents applying same child should skip apply', async function () {
    const controller = setupController(eventData);
    await controller.execute();

    const controller1 = setupController(eventData4, '/default/rr1');
    await controller1.execute();

    assert.isNotNull(kubeData['RemoteResource'][0].status.children[childLink]); // child is indicated on parent1
    assert.equal(kubeData['RemoteResource'][1].status.children, undefined); // child not indicated on second parent
    assert.equal(kubeData['ConfigMap'][0].metadata.name, 'config-test'); // child applied
    assert.equal(kubeData['ConfigMap'][0].metadata.annotations['deploy.razee.io.parent'], parentLink); // child has first parent link
  });

  it('Requests with optional flag should attempt apply all', async function () {
    const controller = setupController(eventData5);
    await controller.execute();

    assert.isNotNull(kubeData['RemoteResource'][0].status.children[childLink]); // child is indicated on parent
    assert.equal(kubeData['ConfigMap'][0].metadata.name, 'config-test'); // child applied
    assert.equal(kubeData['ConfigMap'][0].metadata.annotations['deploy.razee.io.parent'], parentLink); // child has parent link
    assert.equal(kubeData['RemoteResource'][0].status['razee-logs'].warn['485f9f111adca66ff5a65f9e820bd88407af8147'].warn, '1 optional resource(s) failed to process.. skipping reconcileChildren'); // logs should have optional failure warnings
  });

  it('Apply single request with header', async function () {
    const controller = setupController(eventData6);
    await controller.execute();

    assert.equal(Object.keys(kubeData['RemoteResource'][0].status.children)[0], childLink); // child is indicated on parent
    assert.equal(kubeData['ConfigMap'][0].metadata.name, 'config-test'); //child applied
    assert.equal(kubeData['ConfigMap'][0].metadata.annotations['deploy.razee.io.parent'], parentLink); // child has parent link
  });
});
