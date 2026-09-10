import { BrowserMultiFormatReader } from "@zxing/browser";

const SUPPORTED = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "itf",
  "codabar",
  "qr_code",
  "data_matrix",
];

class LocalBarcodeDetector {
  constructor() {
    this.reader = new BrowserMultiFormatReader();
  }

  static async getSupportedFormats() {
    return [...SUPPORTED];
  }

  async detect(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        let finished = false;
        const finish = (callback) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          callback();
        };
        const timeout = window.setTimeout(() => {
          finish(() => reject(new Error("Local barcode reader could not decode the uploaded image.")));
        }, 10000);

        try {
          this.reader.decodeFromImageUrl(objectUrl, (result, error, controls) => {
            if (result) {
              const rawValue = result.getText();
              finish(() => {
                controls?.stop?.();
                resolve([{ rawValue, format: String(result.getBarcodeFormat?.() || "unknown") }]);
              });
              return;
            }

            const name = String(error?.name || "");
            if (error && name !== "NotFoundException" && name !== "ChecksumException" && name !== "FormatException") {
              finish(() => reject(error));
            }
          });
        } catch (error) {
          finish(() => reject(error));
        }
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

globalThis.BarcodeDetector = LocalBarcodeDetector;
