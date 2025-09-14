/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable security/detect-non-literal-regexp */
/* eslint-disable security/detect-object-injection */
/* eslint-disable security/detect-non-literal-fs-filename */
import debug from 'debug';
import directoryExists from 'directory-exists';
import fs from 'fs';
import got from 'got';
import LinkHeader from 'http-link-header';
import path from 'path';
import stream from 'stream';
import unzip from 'unzip-stream';
import { initIndex, dropIndex as dropESIndex } from '../client/elasticsearch.js';
import { download } from '../utils/stream-down.js';
import { setLinkOptions } from './setLinkOptions.js';
import Keyv from 'keyv';
import { KeyvFile } from 'keyv-file';
import crypto from 'crypto';

const fsp = fs.promises;

const logger = debug('api');
const error = debug('error');

const cache = new Keyv({
  store: new KeyvFile({ filename: 'target/keyv-file.msgpack' })
});

const PAGE_SIZE = process.env.PAGE_SIZE || 8;

function getCoveredStates() {
  const covered = process.env.COVERED_STATES || '';
  if (covered === '') {
    return [];
  } else {
    return covered.split(',');
  }
}

const COVERED_STATES = getCoveredStates();

const ONE_DAY_S = 60 * 60 * 24;
const ONE_DAY_MS = 1000 * ONE_DAY_S;
const THIRTY_DAYS_MS = ONE_DAY_MS * 30;
const ES_INDEX_NAME = process.env.ES_INDEX_NAME || 'addressr';

export async function dropIndex() {
  await dropESIndex(global.esClient);
}

export async function clearAddresses() {
  await initIndex(global.esClient, true);
}

export async function setAddresses(addr) {
  await clearAddresses();
  const indexingBody = [];
  addr.forEach(row => {
    indexingBody.push({
      index: { _index: ES_INDEX_NAME, _id: row.links.self.href }
    });
    const { sla, ssla, ...structured } = row;
    indexingBody.push({
      sla,
      ssla,
      structured,
      confidence: structured.structured?.confidence
    });
  });
  if (indexingBody.length > 0) {
    await sendIndexRequest(indexingBody);
  }
}

const GNAF_PACKAGE_URL = process.env.GNAF_PACKAGE_URL ||
  'https://data.gov.au/api/3/action/package_show?id=19432f89-dc3a-4ef3-b943-5326ef1dbecc';

async function fetchPackageData() {
  const packageUrl = GNAF_PACKAGE_URL;
  const cachedResponse = await cache.get(packageUrl);
  logger('cached gnaf package data', cachedResponse);
  let age = 0;
  if (cachedResponse !== undefined) {
    cachedResponse.headers['x-cache'] = 'HIT';
    const created = new Date(cachedResponse.headers.date);
    logger('created', created);
    age = Date.now() - created;
    if (age <= ONE_DAY_MS) {
      return cachedResponse;
    }
  }
  try {
    const response = await got.get(packageUrl);
    logger('response.isFromCache', response.fromCache);
    logger('fresh gnaf package data', { body: response.body, headers: response.headers });
    await cache.set(packageUrl, {
      body: response.body,
      headers: response.headers
    });
    response.headers['x-cache'] = 'MISS';
    return response;
  } catch (error_) {
    if (cachedResponse !== undefined && age < THIRTY_DAYS_MS) {
      cachedResponse.headers['warning'] = '110 custom/1.0 "Response is Stale"';
      return cachedResponse;
    }
    throw error_;
  }
}

const GNAF_DIR = process.env.GNAF_DIR || `target/gnaf`;

export async function fetchGnafFile() {
  const response = await fetchPackageData();
  const pack = JSON.parse(response.body);
  const dataResource = pack.result.resources.find(
    r => r.state === 'active' && r.mimetype === 'application/zip'
  );
  logger('dataResource', JSON.stringify(dataResource, undefined, 2));
  logger('url', dataResource.url);
  logger('headers', JSON.stringify(response.headers, undefined, 2));
  const basename = path.basename(dataResource.url);
  logger('basename', basename);
  const complete_path = GNAF_DIR;
  const incomplete_path = `${complete_path}/incomplete`;
  await fsp.mkdir(incomplete_path, { recursive: true });
  const destination = `${complete_path}/${basename}`;
  await fsp.mkdir(incomplete_path, { recursive: true });
  try {
    await fsp.access(destination, fs.constants.R_OK);
    return destination;
  } catch {
    logger('Starting G-NAF download');
    try {
      await download(
        dataResource.url,
        `${incomplete_path}/${basename}`,
        dataResource.size
      );
      await fsp.rename(`${incomplete_path}/${basename}`, destination);
      logger('Finished downloading G-NAF', destination);
      return destination;
    } catch (error_) {
      error('Error downloading G-NAF', error_);
      throw error_;
    }
  }
}

export async function unzipFile(file) {
  const extname = path.extname(file);
  const basenameWithoutExtention = path.basename(file, extname);
  const incomplete_path = `${GNAF_DIR}/incomplete/${basenameWithoutExtention}`;
  const complete_path = `${GNAF_DIR}/${basenameWithoutExtention}`;
  const exists = await directoryExists(complete_path);
  if (exists) {
    logger('directory exists. Skipping extract', complete_path);
    return complete_path;
  } else {
    await fsp.mkdir(incomplete_path, { recursive: true });
    const readStream = fs.createReadStream(file);
    logger('before pipe');
    await new Promise((resolve, reject) => {
      readStream
        .pipe(unzip.Parse())
        .pipe(
          stream.Transform({
            objectMode: true,
            transform: function (entry, encoding, callback) {
              const entryPath = `${incomplete_path}/${entry.path}`;
              if (entry.isDirectory) {
                fs.mkdir(entryPath, { recursive: true }, error_ => {
                  entry.autodrain();
                  callback(error_ || undefined);
                });
              } else {
                const dirname = path.dirname(entryPath);
                fs.mkdir(dirname, { recursive: true }, error_ => {
                  if (error_) {
                    entry.autodrain();
                    callback(error_);
                  } else {
                    fs.stat(entryPath, (error_, stats) => {
                      if (error_ && error_.code !== 'ENOENT') {
                        logger('error statting file', error_);
                        entry.autodrain();
                        callback(error_);
                        return;
                      }
                      if (stats && stats.size === entry.size) {
                        logger('skipping extract for', entryPath);
                        entry.autodrain();
                        callback();
                      } else {
                        logger('extracting', entryPath);
                        entry
                          .pipe(fs.createWriteStream(entryPath))
                          .on('finish', () => {
                            logger('finished extracting', entryPath);
                            callback();
                          })
                          .on('error', error => {
                            logger('error unzipping entry', error);
                            callback(error);
                          });
                      }
                    });
                  }
                });
              }
            }
          })
        )
        .on('finish', () => {
          logger('finish');
          resolve();
        })
        .on('error', error_ => {
          logger('error unzipping data file', error_);
          reject(error_);
        });
    });
    await fsp.rename(incomplete_path, complete_path);
    return complete_path;
  }
}

function mapGeo(geoSite, context, geoDefault) {
  let foundDefault = false;
  if (geoSite && geoDefault) {
    geoSite.forEach(geo => {
      if (
        geo.GEOCODE_TYPE_CODE === geoDefault[0].GEOCODE_TYPE_CODE &&
        geo.LATITUDE === geoDefault[0].LATITUDE &&
        geo.LONGITUDE === geoDefault[0].LONGITUDE
      ) {
        foundDefault = true;
        geo.default = true;
      } else {
        geo.default = false;
      }
    });
  }
  const sites = geoSite
    ? geoSite.map(geo => {
      if (geo.BOUNDARY_EXTENT !== '') throw new Error('encountered geo.BOUNDARY_EXTENT');
      if (geo.PLANIMETRIC_ACCURACY !== '') throw new Error('encountered geo.PLANIMETRIC_ACCURACY');
      if (geo.ELEVATION !== '') throw new Error('encountered geo.ELEVATION');
      if (geo.GEOCODE_SITE_NAME !== '') throw new Error('encountered geo.GEOCODE_SITE_NAME');
      return {
        default: geo.default || false,
        ...(geo.GEOCODE_TYPE_CODE !== '' && {
          type: {
            code: geo.GEOCODE_TYPE_CODE,
            name: geocodeTypeCodeToName(geo.GEOCODE_TYPE_CODE, context)
          }
        }),
        ...(geo.RELIABILITY_CODE !== '' && {
          reliability: {
            code: geo.RELIABILITY_CODE,
            name: geocodeReliabilityCodeToName(geo.RELIABILITY_CODE, context)
          }
        }),
        ...(geo.LATITUDE !== '' && { latitude: Number.parseFloat(geo.LATITUDE) }),
        ...(geo.LONGITUDE !== '' && { longitude: Number.parseFloat(geo.LONGITUDE) }),
        ...(geo.GEOCODE_SITE_DESCRIPTION !== '' && { description: geo.GEOCODE_SITE_DESCRIPTION })
      };
    })
    : [];
  const def =
    geoDefault && !foundDefault
      ? geoDefault.map(geo => ({
        default: true,
        ...(geo.GEOCODE_TYPE_CODE !== '' && {
          type: {
            code: geo.GEOCODE_TYPE_CODE,
            name: geocodeTypeCodeToName(geo.GEOCODE_TYPE_CODE, context)
          }
        }),
        ...(geo.LATITUDE !== '' && { latitude: Number.parseFloat(geo.LATITUDE) }),
        ...(geo.LONGITUDE !== '' && { longitude: Number.parseFloat(geo.LONGITUDE) })
      }))
      : [];
  return sites.concat(def);
}

function mapToSla(fla) {
  return fla.join(', ');
}

function mapToMla(s) {
  const fla = [];
  if (s.level) {
    fla.push(
      `${s.level.type.name || ''} ${s.level.prefix || ''}${s.level.number || ''}${s.level.suffix || ''}`
    );
  }
  if (s.flat) {
    fla.push(
      `${s.flat.type.name || ''} ${s.flat.prefix || ''}${s.flat.number || ''}${s.flat.suffix || ''}`
    );
  }
  if (s.buildingName) {
    fla.push(s.buildingName);
  }
  if (fla.length === 3) {
    fla[1] = `${fla[0]}, ${fla[1]}`;
    fla.shift();
  }
  let number = '';
  if (s.lotNumber && s.number === undefined) {
    number = `LOT ${s.lotNumber.prefix || ''}${s.lotNumber.number || ''}${s.lotNumber.suffix || ''}`;
  } else if (s.number) {
    number = `${s.number.prefix || ''}${s.number.number || ''}${s.number.suffix || ''}`;
    if (s.number.last) {
      number = `${number}-${s.number.last.prefix || ''}${s.number.last.number || ''}${s.number.last.suffix || ''}`;
    }
  }
  const streetType = s.street.type ? ` ${s.street.type.name}` : '';
  const streetSuffix = s.street.suffix ? ` ${s.street.suffix.name}` : '';
  const street = `${s.street.name}${streetType}${streetSuffix}`;
  fla.push(`${number} ${street}`);
  fla.push(`${s.locality.name} ${s.state.abbreviation} ${s.postcode}`);
  if (fla.length > 4) throw new Error('FLA TOO LONG');
  return fla;
}

function mapToShortMla(s) {
  const fla = [];
  if (s.level) {
    fla.push(
      `${s.level.type.code || ''}${s.level.prefix || ''}${s.level.number || ''}${s.level.suffix || ''}`
    );
  }
  let number = '';
  if (s.flat) number = `${s.flat.prefix || ''}${s.flat.number || ''}${s.flat.suffix || ''}/`;
  if (s.lotNumber && s.number === undefined) {
    number = `${number}${s.lotNumber.prefix || ''}${s.lotNumber.number || ''}${s.lotNumber.suffix || ''}`;
  } else {
    number = `${number}${s.number.prefix || ''}${s.number.number || ''}${s.number.suffix || ''}`;
    if (s.number.last) {
      number = `${number}-${s.number.last.prefix || ''}${s.number.last.number || ''}${s.number.last.suffix || ''}`;
    }
  }
  const streetType = s.street.type ? ` ${s.street.type.name}` : '';
  const streetSuffix = s.street.suffix ? ` ${s.street.suffix.code}` : '';
  const street = `${s.street.name}${streetType}${streetSuffix}`;
  fla.push(`${number} ${street}`);
  fla.push(`${s.locality.name} ${s.state.abbreviation} ${s.postcode}`);
  if (fla.length > 4) throw new Error('FLA TOO LONG');
  return fla;
}

export function mapAddressDetails(d, context, i, count) {
  const streetLocality = context.streetLocalityIndexed[d.STREET_LOCALITY_PID];
  const locality = context.localityIndexed[d.LOCALITY_PID];
  const geoSite = context.geoIndexed ? context.geoIndexed[d.ADDRESS_SITE_PID] : undefined;
  const geoDefault = context.geoDefaultIndexed ? context.geoDefaultIndexed[d.ADDRESS_DETAIL_PID] : undefined;
  const hasGeo =
    d.LEVEL_GEOCODED_CODE != '' &&
    ((geoSite !== undefined && geoSite.length > 0) ||
      (geoDefault !== undefined && geoDefault.length > 0));
  const rval = {
    ...(d.LEVEL_GEOCODED_CODE != '' &&
      hasGeo && {
      geocoding: {
        ...(d.LEVEL_GEOCODED_CODE !== '' && {
          level: {
            code: d.LEVEL_GEOCODED_CODE,
            name: levelGeocodedCodeToName(d.LEVEL_GEOCODED_CODE, context)
          }
        }),
        ...(hasGeo && {
          geocodes: mapGeo(geoSite, context, geoDefault)
        })
      }
    }),
    structured: {
      ...(d.BUILDING_NAME !== '' && {
        buildingName: d.BUILDING_NAME
      }),
      ...((d.NUMBER_FIRST_PREFIX !== '' ||
        d.NUMBER_FIRST !== '' ||
        d.NUMBER_FIRST_SUFFIX !== '') && {
        number: {
          ...(d.NUMBER_FIRST_PREFIX !== '' && {
            prefix: d.NUMBER_FIRST_PREFIX
          }),
          ...(d.NUMBER_FIRST !== '' && {
            number: Number.parseInt(d.NUMBER_FIRST)
          }),
          ...(d.NUMBER_FIRST_SUFFIX !== '' && {
            suffix: d.NUMBER_FIRST_SUFFIX
          }),
          ...((d.NUMBER_LAST_PREFIX !== '' ||
            d.NUMBER_LAST !== '' ||
            d.NUMBER_LAST_SUFFIX !== '') && {
            last: {
              ...(d.NUMBER_LAST_PREFIX !== '' && {
                prefix: d.NUMBER_LAST_PREFIX
              }),
              ...(d.NUMBER_LAST !== '' && {
                number: Number.parseInt(d.NUMBER_LAST)
              }),
              ...(d.NUMBER_LAST_SUFFIX !== '' && {
                suffix: d.NUMBER_LAST_SUFFIX
              })
            }
          })
        }
      }),
      ...((d.LEVEL_TYPE_CODE !== '' ||
        d.LEVEL_NUMBER_PREFIX !== '' ||
        d.LEVEL_NUMBER !== '' ||
        d.LEVEL_NUMBER_SUFFIX !== '') && {
        level: {
          ...(d.LEVEL_TYPE_CODE !== '' && {
            type: {
              code: d.LEVEL_TYPE_CODE,
              name: levelTypeCodeToName(d.LEVEL_TYPE_CODE, context, d)
            }
          }),
          ...(d.LEVEL_NUMBER_PREFIX !== '' && {
            prefix: d.LEVEL_NUMBER_PREFIX
          }),
          ...(d.LEVEL_NUMBER !== '' && {
            number: Number.parseInt(d.LEVEL_NUMBER)
          }),
          ...(d.LEVEL_NUMBER_SUFFIX !== '' && {
            suffix: d.LEVEL_NUMBER_SUFFIX
          })
        }
      }),
      ...((d.FLAT_TYPE_CODE !== '' ||
        d.FLAT_NUMBER_PREFIX !== '' ||
        d.FLAT_NUMBER !== '' ||
        d.FLAT_NUMBER_SUFFIX !== '') && {
        flat: {
          ...(d.FLAT_TYPE_CODE !== '' && {
            type: {
              code: d.FLAT_TYPE_CODE,
              name: flatTypeCodeToName(d.FLAT_TYPE_CODE, context, d)
            }
          }),
          ...(d.FLAT_NUMBER_PREFIX !== '' && {
            prefix: d.FLAT_NUMBER_PREFIX
          }),
          ...(d.FLAT_NUMBER !== '' && {
            number: Number.parseInt(d.FLAT_NUMBER)
          }),
          ...(d.FLAT_NUMBER_SUFFIX !== '' && {
            suffix: d.FLAT_NUMBER_SUFFIX
          })
        }
      }),
      street: mapStreetLocality(streetLocality, context),
      ...(d.CONFIDENCE !== '' && {
        confidence: Number.parseInt(d.CONFIDENCE)
      }),
      locality: mapLocality(locality, context),
      ...(d.POSTCODE !== '' && {
        postcode: d.POSTCODE
      }),
      ...((d.LOT_NUMBER_PREFIX !== '' ||
        d.LOT_NUMBER !== '' ||
        d.LOT_NUMBER_SUFFIX !== '') && {
        lotNumber: {
          ...(d.LOT_NUMBER_PREFIX !== '' && {
            prefix: d.LOT_NUMBER_PREFIX
          }),
          ...(d.LOT_NUMBER !== '' && {
            number: d.LOT_NUMBER
          }),
          ...(d.LOT_NUMBER_SUFFIX !== '' && {
            suffix: d.LOT_NUMBER_SUFFIX
          })
        }
      }),
      state: {
        name: context.stateName,
        abbreviation: context.state
      }
    },
    ...(d.PRIMARY_SECONDARY !== '' && {
      precedence: d.PRIMARY_SECONDARY === 'P' ? 'primary' : 'secondary'
    }),
    pid: d.ADDRESS_DETAIL_PID
  };
  rval.mla = mapToMla(rval.structured);
  rval.sla = mapToSla(rval.mla);
  if (rval.structured.flat != undefined) {
    rval.smla = mapToShortMla(rval.structured);
    rval.ssla = mapToSla(rval.smla);
  }
  if (count) {
    if (i % Math.ceil(count / 100) === 0) {
      logger('addr', JSON.stringify(rval, undefined, 2));
      logger(`${(i / count) * 100}%`);
    }
  } else {
    if (i % 10000 === 0) {
      logger('addr', JSON.stringify(rval, undefined, 2));
      logger(`${i} rows`);
    }
  }
  return rval;
}

function mapToSearchAddressResponse(foundAddresses) {
  return foundAddresses.body.hits.hits.map(h => {
    return {
      sla: h._source.sla,
      score: h._score,
      links: {
        self: {
          href: h._id
        }
      }
    };
  });
}

/**
 * Get Addresses
 * returns detailed information about a specific address
 *
 * addressId String ID of the address.
 * returns Address
 **/
export async function getAddress(addressId) {
  try {
    const jsonX = await global.esClient.get({
      index: ES_INDEX_NAME,
      id: `/addresses/${addressId}`
    });
    logger('jsonX', jsonX);
    const json = {
      ...jsonX.body._source.structured,
      sla: jsonX.body._source.sla
    };
    logger('json', json);
    delete json._id;
    const link = new LinkHeader();
    link.set({
      rel: 'self',
      uri: `/addresses/${addressId}`
    });
    // TODO: store hash in address
    const hash = crypto
      .createHash('md5')
      .update(JSON.stringify(json))
      .digest('hex');

    return { link, json, hash };
  } catch (error_) {
    error('error getting record from elastic search', error_);
    if (error_.body.found === false) {
      return { statusCode: 404, json: { error: 'not found' } };
    } else if (error_.body.error.type === 'index_not_found_exception') {
      return { statusCode: 503, json: { error: 'service unavailable' } };
    } else {
      return { statusCode: 500, json: { error: 'unexpected error' } };
    }
  }
}

/**
 * Get List of Addresses
 * returns a list of addresses matching the search string
 *
 * q String search string (optional)
 * p Integer page number (optional)
 * returns List
 **/
export async function getAddresses(url, swagger, q, p = 1) {
  try {
    const foundAddresses = await searchForAddress(q, p);
    logger('foundAddresses', foundAddresses);
    const link = new LinkHeader();
    link.set({
      rel: 'describedby',
      uri: `/docs/#operations-${swagger.path.get[
        'x-swagger-router-controller'
      ].toLowerCase()}-${swagger.path.get.operationId}`,
      title: `${swagger.path.get.operationId} API Docs`,
      type: 'text/html'
    });
    const sp = new URLSearchParams({
      ...(q !== undefined && { q }),
      ...(p !== 1 && { p })
    });
    const spString = sp.toString();
    link.set({
      rel: 'self',
      uri: `${url}${spString === '' ? '' : '?'}${spString}`
    });
    link.set({
      rel: 'first',
      uri: `${url}${q === undefined ? '' : '?'}${new URLSearchParams({
        ...(q !== undefined && { q })
      }).toString()}`
    });
    if (p > 1) {
      link.set({
        rel: 'prev',
        uri: `${url}${q === undefined && p == 2 ? '' : '?'}${new URLSearchParams({
          ...(q !== undefined && { q }),
          ...(p > 2 && { p: p - 1 })
        }).toString()}`
      });
    }
    logger('TOTAL', foundAddresses.body.hits.total.value);
    logger('PAGE_SIZE * p', PAGE_SIZE * p);
    logger('next?', foundAddresses.body.hits.total.value > PAGE_SIZE * p);

    if (foundAddresses.body.hits.total.value > PAGE_SIZE * p) {
      link.set({
        rel: 'next',
        uri: `${url}?${new URLSearchParams({
          ...(q !== undefined && { q }),
          p: p + 1
        }).toString()}`
      });
    }
    const responseBody = mapToSearchAddressResponse(foundAddresses);
    logger('responseBody', JSON.stringify(responseBody, undefined, 2));

    const linkTemplate = new LinkHeader();
    const op = swagger.path.get;
    setLinkOptions(op, url, linkTemplate);

    return { link, json: responseBody, linkTemplate };
  } catch (error_) {
    error('error querying elastic search', error_);
    if (
      error_.body &&
      error_.body.error &&
      error_.body.error.type === 'index_not_found_exception'
    ) {
      return { statusCode: 503, json: { error: 'service unavailable' } };
    } else if (error_.displayName === 'RequestTimeout') {
      return { statusCode: 504, json: { error: 'gateway timeout' } };
    } else {
      return { statusCode: 500, json: { error: 'unexpected error' } };
    }
  }
}
