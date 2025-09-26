import { PendingError } from '@windyroad/cucumber-js-throwables/lib/pending-error';
import { URI } from 'uri-template-lite';

export class AddressrDriver {
  async getApiRoot() {
    throw new PendingError();
  }

  async getApi(path) {
    throw new PendingError(path);
  }

  async follow(link) {
    throw new PendingError(link);
  }

  async followVarBase(link) {
    throw new PendingError(link);
  }

  async followTemplate(link, parameters) {
    var t = new URI.Template(link.uri);
    const expanded = t.expand(parameters);
    return this.follow(Object.assign({}, link, { uri: expanded }));
  }
}
