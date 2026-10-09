# Bundled Tesseract model

`vie.traineddata` is the **tessdata_fast** Vietnamese LSTM model from
https://github.com/tesseract-ocr/tessdata_fast (Apache-2.0, see `LICENSE`), 531,275 bytes,
sha256 `79df64caf7bcfb2a27df5042ecb6121e196eada34da774956995747636d5bfa1`.
It is read from disk by the local OCR engine (`src/main/document-memory/local-ocr/tesseract-engine.ts`);
nothing is downloaded at run time. Packaged builds copy this folder to `<Resources>/ocr/tessdata`.
