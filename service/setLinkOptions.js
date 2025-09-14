import { encodeUriFragmentIdentifier } from 'json-ptr';

/**
 * Sets link options for an OpenAPI operation on a given link template.
 * @param {object} op - The OpenAPI operation object.
 * @param {string} url - The API path or endpoint.
 * @param {object} linkTemplate - An object/map-like with a .set() method.
 */
export function setLinkOptions(op, url, linkTemplate) {
  if (
    !op ||
    !Array.isArray(op.parameters) ||
    typeof url !== 'string' ||
    !linkTemplate ||
    typeof linkTemplate.set !== 'function'
  ) {
    // Invalid input, do nothing.
    return;
  }

  const queryParameters = op.parameters.filter(
    (parameter) => parameter && parameter.in === 'query'
  );

  const linkOptions = {
    rel: op['x-root-rel'] || '',
    uri: `${url}{?${queryParameters.map((qp) => qp.name).join(',')}}`,
    title: op.summary || '',
    type: 'application/json',
    'var-base': `/api-docs${encodeUriFragmentIdentifier([
      'paths',
      url,
      'get',
      'parameters',
    ])}`,
  };

  linkTemplate.set(linkOptions);
}