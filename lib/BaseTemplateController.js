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

const objectPath = require('object-path');

const CompositeController = require('./CompositeController');
const FetchEnvs = require('./FetchEnvs');

module.exports = class BaseTemplateController extends CompositeController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.basetemplate.deploy.razee.io';
    super(params);
  }

  async added() {
    let fetchEnvs = new FetchEnvs(this);
    let env = await fetchEnvs.get('spec');
    let objTemplates = objectPath.get(this.data, ['object', 'spec', 'templates'], []);
    if (!Array.isArray(objTemplates)) objTemplates = [objTemplates];
    let strTemplates = objectPath.get(this.data, ['object', 'spec', 'strTemplates'], []);
    if (!Array.isArray(strTemplates)) strTemplates = [strTemplates];
    let templates = objTemplates.concat(strTemplates);
    templates = await this.processTemplate(templates, env);
    if (!Array.isArray(templates) || templates.length == 0) {
      this.updateRazeeLogs('warn', { controller: 'BaseTemplate', message: 'No templates found to apply' });
    }
    for (var i = 0; i < templates.length; i++) {
      let rsp = await this.applyChild(templates[i]);
      if (!rsp.statusCode || rsp.statusCode < 200 || rsp.statusCode >= 300) {
        this.log.error(rsp);
        let kind = objectPath.get(rsp, 'body.details.kind') || objectPath.get(templates, [i, 'kind']);
        let group = objectPath.get(rsp, 'body.details.group') || objectPath.get(templates, [i, 'apiVersion']);
        let name = objectPath.get(rsp, 'body.details.name') || objectPath.get(templates, [i, 'metadata', 'name']);
        return Promise.reject(`${kind}.${group} "${name}" status ${rsp.statusCode} ${objectPath.get(rsp, 'body.reason', '')}.. see logs for details`);
      }
    }
    await this.reconcileChildren();
  }

  async processTemplate() {
    // input: Array - templates, Object - env variables and envs pulled from the system
    // output: Array - processed templates ready to be applied
    throw Error('Override BaseTemplateController.processTemplate in the subclass.');
  }

};
