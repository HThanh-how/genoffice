# TrueOCR page models

Frozen from the PyPI wheel **trueocr 0.1.1**, upstream https://github.com/pvd0anh/trueocr.
Models and code: Apache-2.0; the wheel's license is included in LICENSE.
No runtime downloads. Packaged as Resources/ocr/trueocr, outside app.asar.
All four models use ONNX IR 8 and opset 17 and load on the pinned onnxruntime-node 1.23.2 CPU backend.

| File        |   Bytes | SHA-256                                                          |
| ----------- | ------: | ---------------------------------------------------------------- |
| det.onnx    |  389948 | f2bd4cba23e9c328cf7ec824634e423e191a2c6aacbbf35c62bd79dd70f62f59 |
| rec.onnx    | 4280974 | 360b800dcbebd1099270f703ac35a43a6c86b40de049c4be78a130184b3bfef0 |
| order.onnx  | 2973138 | a42db2e8b536ad3d84045a4b7f9b0a72667cf8be4aa02d63f7b38004719fb180 |
| orient.onnx |  371802 | 20eaf670f55a7cf9facfe1bdd6c7b8e40be75bbf4d48a3df43f66aa3bbd874fd |
| meta.json   |    1905 | 934c619f2b8579aa0fa0ead0ec20afc79fd92966be0255ebaf821142fe8740cd |

See docs/local-ocr-trueocr.md for limitations, measurements and update procedure.
