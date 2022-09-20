import yargs from 'yargs';
import path from 'path';
import fs from 'fs';
import * as tf from '@tensorflow/tfjs-node';
import imageSize from 'image-size';
import util from 'util';
import sharp from 'sharp';
import callExec from '../../../test/lib/utils/callExec';
import { mkdirpSync, readdirSync } from 'fs-extra';
import asyncPool from "tiny-async-pool";
import { makeTmpDir } from '../utils/withTmpDir';
import { ModelDefinition } from '@upscalerjs/core';
import { getString } from '../prompt/getString';
const crimsonProgressBar = require("crimson-progressbar");
const Upscaler = require('upscaler/node');
const sizeOf = util.promisify(imageSize);

/****
 * Constants
 */
const ROOT_DIR = path.resolve(__dirname, '../../..');
const CACHE_DIR = path.resolve(ROOT_DIR, './tmp/datasets');

/****
 * Types
 */
interface DatasetDefinition {
  name: string;
  path?: string;
}

interface BenchmarkResult {
  ssim: number;
  psnr: number;
}

interface ImagePackage {
    path: string;
    width: number;
    height: number;
}

interface ProcessedFileDefinition {
  original: ImagePackage;
  downscaled: ImagePackage;
  cropped: Record<number, {
    original: ImagePackage;
    downscaled: ImagePackage;
  }>;
  fileName: string;
}

type DatasetDatabase = Record<string, Record<number, ProcessedFileDefinition>>;

/****
 * Utility Functions & Classes
 */

function getFiles(dir: string): string[] {
  const dirents = readdirSync(dir, { withFileTypes: true });
  let files: string[] = [];
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      for (const filename of getFiles(path.resolve(dir, dirent.name))) {
        files.push(path.join(dirent.name, filename));
      }
    } else {
      const ext = dirent.name.split('.').pop();
      if (typeof ext === 'string' && ['jpg', 'jpeg', 'png'].includes(ext)) {
        files.push(dirent.name);
      }
    }
  }
  return files;
}

const avg = (arr: number[]) => arr.reduce((sum, num) => sum + num, 0) / arr.length;

const getSize = async (file: string): Promise<{ width: number; height: number }> => {
  const dimensions = await sizeOf(file);
  if (!dimensions?.width || !dimensions?.height) {
    throw new Error(`No dimensions found for file ${file}.`)
  }
  return { width: dimensions.width, height: dimensions.height };
}

const checkImagemagickInstallation = async () => {
  try {
    await callExec('convert -version');
  } catch (err) {
    throw new Error('Imagemagick does not appear to be installed. Please install it for your system.');
  }
}

export const runScript = async (cmd: string) => {
  let stdout = '';
  let stderr = '';
  let err: unknown = '';
  try {
    await callExec(cmd, {}, _data => {
      stdout += _data;
    }, _data => {
      stderr += _data;
    });
  } catch (_err) {
    err = _err;
  }
  return [stdout, stderr, err];
};

class Dataset {
  definition: DatasetDefinition;
  database: DatasetDatabase;

  constructor(datasetDefinition: DatasetDefinition) {
    this.definition = datasetDefinition;

    // see if we have processed a dataset with this name
    this.database = this.getDatasetDatabase();
  }

  async initialize(scale: number, cropped?: number) {
    const { name: definitionName, path: definitionPath } = this.definition;
    if (!definitionPath) {
      throw new Error([
        `The dataset ${definitionName} has not been fully processed, and you've neglected to pass a path to the dataset.`,
        `Please pass a valid path so that the dataset can be processed and cached.`
      ].join(' '));
    }
    const files = getFiles(definitionPath).map(file => ({
      file,
      filePath: path.resolve(definitionPath, file),
    }));
    let i = 0;
    const total = files.length;
    crimsonProgressBar.renderProgressBar(i, total);
    await this.prepare(files, scale, () => {
      i++;
      crimsonProgressBar.renderProgressBar(i, total);
    }, cropped);
    this.saveDatabase();
  }

  getWritableName(name: string) {
    const folder = this.definition.name;
    const parts = name.split('.');
    if (parts.length < 1) {
      throw new Error('No name provided');
    }
    const formattedName = parts.join('.').split('/').join('-');
    return path.resolve(CACHE_DIR, folder, formattedName);
  }

  getDatasetDatabase(): DatasetDatabase {
    try {
      const filename = this.getWritableName('database.json');
      const parsedDatabaseFile = JSON.parse(fs.readFileSync(filename, 'utf-8'));
      return parsedDatabaseFile;
    } catch (err) {
    }
    return {};
  }

  saveDatabase(key?: string, payload?: any) {
    if (key) {
      this.database[key] = {
        ...this.database[key],
        ...payload,
      }
    }
    const filename = this.getWritableName('database.json');
    mkdirpSync(path.dirname(filename));
    fs.writeFileSync(filename, JSON.stringify(this.database));
  }

  saveImage(filename: string, image: Buffer) {
    const originalPath = this.getWritableName(filename) + '.png';
    mkdirpSync(path.dirname(originalPath));
    fs.writeFileSync(originalPath, image);
    return originalPath;
  }

  async prepare(files: { file: string; filePath: string }[], scale: number, callback: () => void, cropped?: number) {
    const getDims = (fn: (size: number) => number, ...nums: number[]) => nums.map(fn);
    const processOriginal = async (filePath: string, filename: string) => {
      if (this.database[filename]?.[scale]) {
        return;
      }
      const { width, height } = await getSize(filePath);

      const [originalWidth, originalHeight] = getDims(n => Math.floor(n / scale) * scale, width, height);
      const originalImage = await sharp(filePath)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize({ width: originalWidth, height: originalHeight, fit: 'cover' })
        .toBuffer();
      const originalPath = this.saveImage(`${filename}-scale-${scale}-original`, originalImage);

      const [downscaledWidth, downscaledHeight] = getDims(n => n / scale, width, height);
      const downscaledImage = await sharp(originalImage)
        .resize({ width: downscaledWidth, height: downscaledHeight })
        .toBuffer();
      const downscaledPath = this.saveImage(`${filename}-scale-${scale}-downscaled`, downscaledImage);

      this.saveDatabase(filename, {
        [scale]: {
          cropped: {},
          original: {
            path: originalPath,
            width: originalWidth,
            height: originalHeight,
          },
          downscaled: {
            path: downscaledPath,
            width: downscaledWidth,
            height: downscaledHeight,
          },
          fileName: filename,
        },
      });
    };
    const processFile = async ({ file: filename, filePath }: { file: string; filePath: string }) => {
      const processedFile = this.database[filename];
      if (processedFile?.[scale]) {
        if (cropped === undefined) {
          return;
        }
        if (processedFile?.[scale].cropped[cropped]) {
          return;
        }
      }

      await processOriginal(filePath, filename);

      const {
        original: {
          path: originalPath,
          height: originalHeight,
          width: originalWidth,
        },
      } = this.database[filename][scale];

      if (cropped && !this.database[filename][scale].cropped[cropped]) {
        const [originalCroppedWidth, originalCroppedHeight] = [cropped, cropped];
        const originalCroppedImage = await sharp(originalPath)
          .extract({ width: originalCroppedWidth, height: originalCroppedHeight, top: (originalHeight / 2) - (originalCroppedHeight / 2), left: (originalWidth / 2) - (originalCroppedWidth / 2) })
          .toBuffer();
        const originalCroppedPath = this.saveImage(`${filename}-scale-${scale}-cropped-${cropped}-original`, originalCroppedImage);

        const [downscaledCroppedWidth, downscaledCroppedHeight] = getDims(n => n / scale, originalCroppedWidth, originalCroppedHeight);
        const downscaledCroppedImage = await sharp(originalCroppedImage)
          .resize({ width: downscaledCroppedWidth, height: downscaledCroppedHeight })
          .toBuffer();
        const downscaledCroppedPath = this.saveImage(`${filename}-scale-${scale}-cropped-${cropped}-downscaled`, downscaledCroppedImage);

        this.saveDatabase(filename, {
          [scale]: {
            ...this.database[filename][scale],
            cropped: {
              ...this.database[filename][scale].cropped,
              [cropped]: {
                original: {
                  path: originalCroppedPath,
                  width: originalCroppedWidth,
                  height: originalCroppedHeight,
                },
                downscaled: {
                  path: downscaledCroppedPath,
                  width: downscaledCroppedWidth,
                  height: downscaledCroppedHeight,
                },
              }
            }
          }
        });
      }
    }

    for await (const _ of asyncPool(20, files, processFile)) {
      callback();
    }
  }

  getFiles(scale: number, cropped?: number) {
    const fileNames = Object.keys(this.database).sort();
    return fileNames.map(fileName => {
      const file = this.database[fileName][scale];
      if (cropped) {
        if (!file.cropped[cropped]) {
          throw new Error(`No cropping exists for ${cropped}`);
        }
        return {
          original: file.cropped[cropped].original,
          downscaled: file.cropped[cropped].downscaled,
          fileName: file.fileName,
        }
      }

      return {
        original: file.original,
        downscaled: file.downscaled,
        fileName: file.fileName,
      }
    });
  }
}

class Benchmarker {
  n: number;

  private models: Map<string, Promise<typeof Upscaler>>;
  private datasets: Map<string, Dataset>;

  private tmpDir: string = '';

  constructor(models: string[], datasets: Dataset[], n: number = Infinity, cropped?: number) {
    this.n = n;
    this.models = new Map();
    this.datasets = new Map();
    this.tmpDir = makeTmpDir();
    mkdirpSync(this.tmpDir);
    for (const modelName of models) {
      const pathToModel = path.resolve(ROOT_DIR, 'models', modelName);
      this.models.set(modelName, import(pathToModel).then(model => new Upscaler(model)));
    }
    for (const dataset of datasets) {
      this.datasets.set(dataset.definition.name, dataset);
    }
    this.benchmark(cropped);
  }

  cleanup() {
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }

  private async upscale(_upscaler: Promise<typeof Upscaler>, downscaled: string, progress?: (rate: number) => void): Promise<Buffer> {
    const upscaler = await _upscaler;
    const upscaledData = await upscaler.upscale(downscaled, {
      output: 'tensor',
      patchSize: 64,
      padding: 2,
      progress,
    });
    const data = await tf.node.encodePng(upscaledData);
    return Buffer.from(data);
  }

  private async calculatePerformance(upscaledPath: string, originalPath: string, diffPath: string, metric: 'ssim' | 'psnr'): Promise<number> {
    const [_, out,] = await runScript(`magick compare -metric ${metric} ${upscaledPath} ${originalPath} ${diffPath}`);
    if (typeof out !== 'string') {
      throw new Error('No response from metric calculation');
    }
    const value = out.split(' ')[0];
    if (!value) {
      throw new Error('No metric found')
    }
    return parseFloat(value);
  }

  private async benchmark(cropped?: number) {
    const upscaledFolder = path.resolve(this.tmpDir, 'upscaled');
    const diffFolder = path.resolve(this.tmpDir, 'diff');
    const results = new Map<{ dataset: Dataset; modelDefinition: ModelDefinition }, BenchmarkResult>();
    for (const [_datasetName, dataset] of this.datasets) {
      for (const [_modelName, _model] of this.models) {
        const model = await _model;
        const { modelDefinition } = await model.getModel();
        await dataset.initialize(modelDefinition.scale, cropped);
        const files = dataset.getFiles(modelDefinition.scale, cropped);
        const n = Math.min(this.n, files.length);
        const ssim: number[] = [];
        const psnr: number[] = [];

        crimsonProgressBar.renderProgressBar(0, n);
        let i = 0;
        // const progress = (rate: number) => console.log(rate);
        const processFile = async ({
          original,
          downscaled,
          fileName: file,
        }: { original: ImagePackage; downscaled: ImagePackage; fileName: string; }) => {
          const {
            width: originalWidth,
            height: originalHeight,
            path: originalPath,
          } = original;
          const {
            path: downscaledPath,
          } = downscaled;
          const upscaledBuffer = await this.upscale(model, downscaledPath, 
            // progress
            );
          const upscaledPath = path.resolve(upscaledFolder, file)
          mkdirpSync(path.dirname(upscaledPath));
          fs.writeFileSync(upscaledPath, upscaledBuffer);
          const upscaledDimensions = await getSize(upscaledPath);

          const diffPath = path.resolve(diffFolder, file);
          mkdirpSync(path.dirname(diffPath));

          if (originalWidth !== upscaledDimensions.width || originalHeight !== upscaledDimensions.height) {
            throw new Error(`Dimensions mismatch. Original image: ${JSON.stringify({ originalWidth, originalHeight })}, Upscaled image: ${JSON.stringify(upscaledDimensions)}`)
          }
          ssim.push(await this.calculatePerformance(upscaledPath, originalPath, diffPath, 'ssim'));
          psnr.push(await this.calculatePerformance(upscaledPath, originalPath, diffPath, 'psnr'));
        }
        
        for await (const value of asyncPool(1, files, processFile)) {
          i++;
          crimsonProgressBar.renderProgressBar(i, n);
        }

        results.set({
          modelDefinition,
          dataset,
        }, {
          psnr: avg(psnr),
          ssim: avg(ssim),
        });
      }
    }
    results.forEach((value, { modelDefinition, dataset }) => {
      console.log('Result for model', modelDefinition.packageInformation?.name, 'with scale', modelDefinition.scale, 'for dataset', dataset.definition.name);
      console.log(value);
    });
  }
}

/****
 * Main function
 */

type BenchmarkPerformance = (models: string[], datasets: DatasetDefinition[], props?: { outputFile?: string, n?: number, cropped?: number }) => Promise<void>;
const benchmarkPerformance: BenchmarkPerformance = async (models, datasetDefinitions, { n = Infinity, outputFile, cropped } = {}) => new Promise(async (resolve, reject) => {
  const datasets = datasetDefinitions.map(dataset => {
    return new Dataset(dataset);
  });
  const benchmarker = new Benchmarker(models, datasets, n, cropped);
  benchmarker.cleanup();
  return 'foo';
});

export default benchmarkPerformance;

/****
 * Functions to expose the main function as a CLI tool
 */
interface Args {
  dataset: DatasetDefinition;
  outputFile?: string;
  n?: number;
  cropped?: number;
}

const getDataset = async (_datasetName?: unknown, _datasetPath?: unknown): Promise<DatasetDefinition> => {
  if (typeof _datasetName === 'string' && _datasetName) {
    return {
      name: _datasetName,
      path: `${_datasetPath || ''}`,
    };
  }
  const datasetName = await getString('What is the name of the dataset you wish to use?', _datasetName);
  const datasetPath = await getString('What is the path to the dataset you wish to use?', _datasetPath);

  return {
    name: datasetName,
    path: datasetPath,
  };
}

const getArgs = async (): Promise<Args> => {
  const argv = await yargs.command('benchmark-performance <dataset> <output-file>', 'benchmark performance', yargs => {
    yargs.positional('datasetName', {
      describe: 'The name of the dataset',
    }).positional('datasetPath', {
      describe: 'The path to the dataset to run inference against',
    }).options({
      outputFile: { type: 'string' },
      n: { type: 'number' },
      cropped: { type: 'number' },
    });
  })
  .help()
  .argv;

  const dataset = await getDataset(argv._[0], argv._[1]);

  return {
    dataset,
    outputFile: typeof argv.outputFile === 'string' ? argv.outputFile : undefined,
    n: typeof argv.n === 'number' ? argv.n : undefined,
    cropped: typeof argv.cropped === 'number' ? argv.cropped : undefined,
  }
}

if (require.main === module) {
  (async () => {
    await checkImagemagickInstallation()
    const { dataset, outputFile, n, cropped } = await getArgs();
    await benchmarkPerformance(['esrgan-slim/dist/cjs/index.js'], [dataset], { outputFile, n, cropped });
  })();
}