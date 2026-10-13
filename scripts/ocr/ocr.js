// Prints the text macOS's Vision framework reads in each image, one JSON line per image:
//   {"file": "...", "lines": [{"text": "...", "x": 0.1, "y": 0.8, "w": 0.3, "h": 0.05}]}
// x, y, w, h are fractions of the image, y measured from the top. No compiler needed:
//   osascript -l JavaScript scripts/ocr/ocr.js a.jpg b.jpg
ObjC.import("Vision");
ObjC.import("AppKit");
function run(argv) {
  const out = [];
  for (const path of argv) {
    const img = $.NSImage.alloc.initWithContentsOfFile(path);
    const lines = [];
    if (img && !img.isNil()) {
      const cg = img.CGImageForProposedRectContextHints(null, $(), $.NSDictionary.dictionary);
      const req = $.VNRecognizeTextRequest.alloc.init;
      req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
      req.usesLanguageCorrection = false;
      const h = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $.NSDictionary.dictionary);
      h.performRequestsError($([req]), null);
      const res = req.results;
      for (let i = 0; i < res.count; i++) {
        const o = res.objectAtIndex(i);
        const t = o.topCandidates(1).objectAtIndex(0);
        const b = o.boundingBox;
        lines.push({ text: t.string.js, x: b.origin.x, y: 1 - b.origin.y - b.size.height, w: b.size.width, h: b.size.height });
      }
    }
    out.push(JSON.stringify({ file: path, lines }));
  }
  return out.join("\n");
}
