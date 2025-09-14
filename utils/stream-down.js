import { parse } from 'url';
import http from 'https';
import fs from 'fs';
import path from 'path';
import ProgressBar from 'progress';

/**
 * Downloads a file from a URL and saves it to disk with a progress bar.
 * @param {string} url - The URL to download.
 * @param {string} [destPath] - Destination path (optional; defaults to basename).
 * @param {number} [size] - Known file size in bytes (optional).
 * @returns {Promise<void>}
 */
export async function download(url, destPath, size) {
  const uri = parse(url);
  if (!destPath) {
    destPath = path.basename(uri.path);
  }
  const file = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    http.get(uri.href).on('response', function (res) {
      const length = res.headers['content-length']
        ? Number.parseInt(res.headers['content-length'], 10)
        : size;
      const bar = new ProgressBar(
        '  downloading [:bar] :rate/bps :percent :etas',
        {
          complete: '=',
          incomplete: ' ',
          width: 20,
          total: length,
        }
      );

      res
        .on('data', function (chunk) {
          file.write(chunk);
          bar.tick(chunk.length);
        })
        .on('end', function () {
          file.end();
          console.log(`\n${uri.path} downloaded to: ${destPath}`);
          resolve(res);
        })
        .on('error', function (error) {
          reject(error);
        });
    });
  });
}