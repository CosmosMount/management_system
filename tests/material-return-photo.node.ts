import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMaterialReturnPhotoContent,
  isMaterialReturnPhotoStoragePath,
  MAX_MATERIAL_RETURN_PHOTO_SIZE,
} from "../lib/material-management/return-photo-file";
import { uploadCacheControl } from "../lib/upload-response-policy";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

test("material return photo requires a strict declared MIME matching its signature", () => {
  assert.equal(assertMaterialReturnPhotoContent(PNG, "image/png"), "image/png");
  assert.throws(
    () => assertMaterialReturnPhotoContent(PNG, ""),
    /仅支持 PNG/,
  );
  assert.throws(
    () => assertMaterialReturnPhotoContent(PNG, "application/octet-stream"),
    /仅支持 PNG/,
  );
  assert.throws(
    () => assertMaterialReturnPhotoContent(PNG, "image/jpeg"),
    /声明的图片格式不一致/,
  );
  assert.throws(
    () => assertMaterialReturnPhotoContent(Buffer.from("not-an-image"), "image/png"),
    /图片格式不匹配/,
  );
});

test("material return photo size limit remains 8MB", () => {
  assert.equal(MAX_MATERIAL_RETURN_PHOTO_SIZE, 8 * 1024 * 1024);
});
test("material return photo storage path belongs to exactly one loan directory", () => {
  const loanId = "6b7639fc-00ad-4438-9f98-dbeeb6a24d92";
  assert.equal(
    isMaterialReturnPhotoStoragePath(`materials/${loanId}/photo.png`, loanId),
    true,
  );
  assert.equal(
    isMaterialReturnPhotoStoragePath(
      `materials/${loanId}/../other-loan/photo.png`,
      loanId,
    ),
    false,
  );
  assert.equal(
    isMaterialReturnPhotoStoragePath(`materials/${loanId}/nested/photo.png`, loanId),
    false,
  );
  assert.equal(
    isMaterialReturnPhotoStoragePath(`materials\\${loanId}\\photo.png`, loanId),
    false,
  );
});

test("material return photos are never cached after authorization", () => {
  assert.equal(
    uploadCacheControl("MATERIAL_RETURN_PHOTO"),
    "private, no-store, max-age=0",
  );
  assert.equal(uploadCacheControl("ORDER_ATTACHMENT"), "private, max-age=3600");
});
