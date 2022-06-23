const MockKubeResourceMeta = require('../lib/MockKubeResourceMeta');

module.exports = class MockController {
  constructor(eventData, kubeData) {
    this.data = eventData;
    this.kubeResourceMeta = new MockKubeResourceMeta(
      this.data.object.apiVersion,
      this.data.object.kind,
      kubeData
    );
    this.kubeClass = {
      getKubeResourceMeta: (apiVersion, kind) => {
        return new MockKubeResourceMeta(apiVersion, kind, kubeData);
      }
    };
  }
};
