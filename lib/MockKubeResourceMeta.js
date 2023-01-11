const merge = require('deepmerge');
const yaml = require('js-yaml');

module.exports = class MockKubeResourceMeta {
  constructor(apiVersion, kind, kubeData) {
    this._apiVersion = ((apiVersion === undefined || apiVersion === '') ? 'deploy.razee.io/v1alpha2' : apiVersion);
    this._kind = ((kind === undefined || kind === '') ? 'MustacheTemplate' : kind);
    this.kubeData = kubeData;
  }

  async request(reqOpt) {
    try {
      let uri = JSON.parse(reqOpt.uri);
      if (uri.kind) {
        const ref = {
          apiVersion: uri.apiVersion,
          kind: uri.kind,
          name: uri.name,
          namespace: uri.namespace,
          labelSelector: reqOpt?.qs?.labelSelector
        };
    
        if (reqOpt.method == 'DELETE') {
          const i = this.kubeData[uri.kind].findIndex(i => i.metadata.name == uri.name && i.metadata.namespace == uri.namespace);
          this.kubeData[uri.kind].splice(i, 1);
          return {statusCode: 200, body: this.kubeData[uri.kind]};
        } else if (reqOpt.method == 'GET'){
          const res = await this.kubeGetResource(ref);
          return { statusCode: 200, body: yaml.dump(res) };
        } else {
          const res = await this.kubeGetResource(ref);
          return res;
        }
      }
    } catch(e) {
      if (reqOpt.uri.includes('secret')) {
        return {data: {'testtoken': 'testsecret'}};
      }
    }
  }

  async get(name, namespace) {
    const ref = JSON.parse(this.uri({ name, namespace }));
    const get = await this.kubeGetResource(ref);
    if (namespace == 'razeedeploy') {
      return get;
    } else if (get) {
      return { statusCode: 200, body: get };
    } else {
      return { statusCode: 404 };
    }
  }

  uri(options) {
    return JSON.stringify({ ...options, apiVersion: this._apiVersion, kind: this._kind, });
  }

  async kubeGetResource(ref) {
    const {
      name,
      labelSelector,
      namespace,
      kind,
      apiVersion
    } = ref;
    if (!this.kubeData[kind]) {
      return;
    }

    let fn = labelSelector ? 'filter' : 'find';
    let lookup = this.kubeData[kind][fn](obj => {
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

  post(file) {
    this.kubeData[this._kind].push(file);
    return {statusCode: 200};
  }

  async mergePatch(name, ns, mPatch) {
    const uri = JSON.parse(this.uri({ name: name, namespace: ns }));
    const get = await this.kubeGetResource(uri);
    
    const i = this.kubeData[this._kind].findIndex(i => i.metadata.name == get.metadata.name && i.metadata.namespace == get.metadata.namespace);
    this.kubeData[this._kind][i] = merge(get, mPatch);
    const ret = this.kubeData[this._kind][i];

    if (mPatch.kind) {
      return { statusCode: 200, body: ret };
    } else {
      return ret;
    }
  }
};
