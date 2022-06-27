module.exports = class MockKubeResourceMeta {
  constructor(apiVersion, kind, kubeData) {
    this._apiVersion = ((apiVersion === undefined || apiVersion === '') ? 'deploy.razee.io/v1alpha2' : apiVersion);
    this._kind = ((kind === undefined || kind === '') ? 'MustacheTemplate' : kind);
    this.kubeData = kubeData;
  }

  async request(reqOpt) {
    const ref = {
      apiVersion: reqOpt.uri.apiVersion,
      kind: reqOpt.uri.kind,
      name: reqOpt.uri.name,
      namespace: reqOpt.uri.namespace,
      labelSelector: reqOpt?.qs?.labelSelector
    };

    const res = await this.kubeGetResource(ref);
    return res;
  }

  async get(name, namespace) {
    const ref = this.uri({ name, namespace });
    return await this.kubeGetResource(ref);
  }

  uri(options) {
    return { ...options, apiVersion: this._apiVersion, kind: this._kind, };
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
};
