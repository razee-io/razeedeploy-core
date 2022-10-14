/**
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

const { EventHandler } = require('@razee/kubernetes-util');

module.exports = class RRMEventHandler extends EventHandler{
  constructor(params={}){
    super(params);
    this._managedResourceType=params.managedResourceType;
    //console.log(`set up managedResourceType: ${this._managedResourceType}, ${params.managedResourceType}`);
  }

  // Override base EventHandler to pass managedResourceType with other params
  async eventHandler(data) {
    let params = {
      kubeResourceMeta: this._kubeResourceMeta.clone(),
      eventData: data,
      kubeClass: this._kc,
      logger: this._logger,
      finalizerString: this._finalizerString,
      managedResourceType: this._managedResourceType
    };
    //console.log(`before execute managedResourceType: ${this._managedResourceType}, ${params.managedResourceType}`)
    const controller = new this._factory(params);
    return await controller.execute();
  }
};
