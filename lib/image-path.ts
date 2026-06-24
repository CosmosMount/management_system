const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function isImagePath(path: string): boolean {
  const withoutQuery = path.split("?")[0] ?? path;
  return IMAGE_PATH_RE.test(withoutQuery);
}
