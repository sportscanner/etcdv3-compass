// Generate a PNG icon from the SVG for the marketplace icon
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function run() {
  const svgPath = path.resolve(__dirname, '../media/etcd.svg');
  const pngPath = path.resolve(__dirname, '../media/etcd.png');
  const activityPath = path.resolve(__dirname, '../media/etcd-activity.png');
  if (!fs.existsSync(svgPath)) {
    console.error('SVG icon not found at', svgPath);
    process.exit(1);
  }
  await sharp(svgPath)
    .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(pngPath);
  await sharp(svgPath)
    .resize(24, 24, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(activityPath);
  console.log('Icons written to', pngPath, 'and', activityPath);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});


