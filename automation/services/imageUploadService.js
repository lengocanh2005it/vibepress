const crypto = require('crypto');
const path = require('path');
const { readFile, stat } = require('fs/promises');

const {
  CLOUD_IMAGE_PROVIDER,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  CLOUDINARY_FOLDER,
  IMAGEKIT_PUBLIC_KEY,
  IMAGEKIT_PRIVATE_KEY,
  IMAGEKIT_FOLDER,
} = require('../config/constants');

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function buildCloudinarySignature(params, apiSecret) {
  const serialized = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto
    .createHash('sha1')
    .update(`${serialized}${apiSecret}`)
    .digest('hex');
}

async function uploadToCloudinary(filePath, filename) {
  if (
    !CLOUDINARY_CLOUD_NAME ||
    !CLOUDINARY_API_KEY ||
    !CLOUDINARY_API_SECRET
  ) {
    return null;
  }

  const fileBuffer = await readFile(filePath);
  const mimeType = getMimeType(filePath);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = path.parse(filename).name;
  const signature = buildCloudinarySignature(
    {
      folder: CLOUDINARY_FOLDER,
      public_id: publicId,
      timestamp,
    },
    CLOUDINARY_API_SECRET,
  );

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('public_id', publicId);
  if (CLOUDINARY_FOLDER) {
    form.append('folder', CLOUDINARY_FOLDER);
  }
  form.append('signature', signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    {
      method: 'POST',
      body: form,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudinary upload failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    provider: 'cloudinary',
    fileName: filename,
    originalPath: filePath,
    url: data.secure_url,
    bytes: data.bytes,
    mimeType,
    width: data.width,
    height: data.height,
    publicId: data.public_id,
    format: data.format,
    createdAt: data.created_at,
  };
}

async function uploadToImageKit(filePath, filename) {
  if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY) {
    return null;
  }

  const fileBuffer = await readFile(filePath);
  const mimeType = getMimeType(filePath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
  form.append('fileName', filename);
  if (IMAGEKIT_FOLDER) {
    form.append('folder', IMAGEKIT_FOLDER);
  }
  form.append('useUniqueFileName', 'true');

  const basicAuth = Buffer.from(
    `${IMAGEKIT_PUBLIC_KEY}:${IMAGEKIT_PRIVATE_KEY}`,
  ).toString('base64');

  const response = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ImageKit upload failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    provider: 'imagekit',
    fileName: data.name || filename,
    originalPath: filePath,
    url: data.url,
    bytes: data.size,
    mimeType: data.fileType || mimeType,
    width: data.width,
    height: data.height,
    fileId: data.fileId,
    filePath: data.filePath,
    createdAt: data.createdAt,
  };
}

async function buildLocalAssetMetadata(filePath, filename, publicUrl, dimensions) {
  const fileStats = await stat(filePath);
  return {
    provider: 'local',
    fileName: filename,
    originalPath: filePath,
    url: publicUrl,
    bytes: fileStats.size,
    mimeType: getMimeType(filePath),
    width: dimensions?.width,
    height: dimensions?.height,
  };
}

async function uploadCaptureAsset(filePath, filename, fallbackPublicUrl, dimensions) {
  const provider = (CLOUD_IMAGE_PROVIDER || '').trim().toLowerCase();

  if (!provider || provider === 'local') {
    return buildLocalAssetMetadata(
      filePath,
      filename,
      fallbackPublicUrl,
      dimensions,
    );
  }

  if (provider === 'cloudinary') {
    return (
      (await uploadToCloudinary(filePath, filename)) ||
      buildLocalAssetMetadata(filePath, filename, fallbackPublicUrl, dimensions)
    );
  }

  if (provider === 'imagekit') {
    return (
      (await uploadToImageKit(filePath, filename)) ||
      buildLocalAssetMetadata(filePath, filename, fallbackPublicUrl, dimensions)
    );
  }

  throw new Error(
    `Unsupported CLOUD_IMAGE_PROVIDER "${CLOUD_IMAGE_PROVIDER}". Use "cloudinary", "imagekit", or leave empty.`,
  );
}

module.exports = {
  uploadCaptureAsset,
};
