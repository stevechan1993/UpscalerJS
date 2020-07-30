import * as tf from '@tensorflow/tfjs';
import { IUpscalerOptions, IUpscaleOptions } from './types';
import loadModel from './loadModel';
import warmup from './warmup';
import upscale from './upscale';

class Upscaler {
  _opts: IUpscalerOptions;
  _model: Promise<tf.LayersModel>;

  constructor(opts: IUpscalerOptions) {
    this._opts = opts;
    this._model = loadModel(this._opts);
    warmup(this._model, this._opts.warmupSizes || []);
  }

  getModel = () => this._model;
  warmup = (warmupSizes: Array<[number, number]>) => warmup(this._model, warmupSizes);

  upscale = async (pixels: tf.Tensor3D, options: IUpscaleOptions = {}) => {
    const model = await this._model;
    return upscale(model, pixels, options);
  }
}

export default Upscaler;