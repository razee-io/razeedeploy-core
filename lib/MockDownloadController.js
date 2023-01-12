const MockKubeResourceMeta = require('../lib/MockKubeResourceMeta');
const BaseDownloadController = require('./BaseDownloadController');
const log = require('./bunyan-api').createLogger();
const fs = require('fs-extra');

module.exports = class MockDownloadController extends BaseDownloadController {
  constructor(eventData, kubeData) {
    const params = {};
    params.eventData = eventData;
    params.logger = log;
    params.eventData.type = 'ADDED';
    params.kubeResourceMeta = new MockKubeResourceMeta(
      eventData.object.apiVersion,
      eventData.object.kind,
      kubeData
    );
    params.kubeClass = {
      getKubeResourceMeta: (apiVersion, kind) => {
        return new MockKubeResourceMeta(apiVersion, kind, kubeData);
      }
    };

    super(params);
  }

  async download(reqOpt) {
    let split = reqOpt.url.split('/');
    let filename = split[split.length -1];
    const file = await fs.readFile(`test/test-configs/${filename}`);
    return {statusCode: 200, body: file};
  }
};
