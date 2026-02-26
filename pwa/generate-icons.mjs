import sharp from 'sharp'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="80" fill="#0f3460"/>
  <text x="256" y="340" font-size="320" text-anchor="middle" fill="#e94560">🔑</text>
</svg>`

const buf = Buffer.from(svg)

await sharp(buf).resize(192, 192).png().toFile('public/icons/icon-192.png')
await sharp(buf).resize(512, 512).png().toFile('public/icons/icon-512.png')

console.log('Icons generated!')