const ROOT = 'https://unpkg.com/upscalerjs-models';
const MODEL_DIR = 'models';

const buildURL = (modelFolder: string) => {
  return `${ROOT}@latest/${MODEL_DIR}/${modelFolder}/model.json`;
};

interface IModels {
  [index: string]: {
    url: string;
    scale: number;
  };
}

const MODELS: IModels = {
  '2x': {
    url: buildURL('div2k/005-2x'),
    scale: 2,
  },
  '3x': {
    url: buildURL('div2k/019-3x'),
    scale: 3,
  },
  '4x': {
    url: buildURL('div2k/017-4x'),
    scale: 4,
  },
  psnr: {
    url: buildURL('psnr-small-quant-uint8'),
    scale: 2,
  },
};

export default MODELS;

export const DEFAULT_MODEL = '2x';