// Temporary authenticated multipart uploader. Delete this Worker after uploading.
const key = "AzerothSurvivorsWindowsNew.rar";
interface Env { DOWNLOADS: R2Bucket; UPLOAD_TOKEN: string }
export default {
  async fetch(request, env) {
    if (!env.UPLOAD_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.UPLOAD_TOKEN}`) {
      return new Response("Not found", { status: 404 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/start" && request.method === "POST") {
      const upload = await env.DOWNLOADS.createMultipartUpload(key, {
        httpMetadata: { contentType: "application/vnd.rar", contentDisposition: `attachment; filename="${key}"` },
        customMetadata: { sha256: "971db7968dc37ec50b18d64a1de7f693e137f6793a7368e4d5c27bd9522eccd8" },
      });
      return Response.json({ uploadId: upload.uploadId });
    }
    const id = url.searchParams.get("uploadId");
    if (!id) return new Response("Missing uploadId", { status: 400 });
    const upload = env.DOWNLOADS.resumeMultipartUpload(key, id);
    if (url.pathname === "/part" && request.method === "PUT" && request.body) {
      const number = Number(url.searchParams.get("number"));
      if (!Number.isInteger(number) || number < 1 || number > 10000) return new Response("Invalid part", { status: 400 });
      return Response.json(await upload.uploadPart(number, request.body));
    }
    if (url.pathname === "/complete" && request.method === "POST") {
      const parts: R2UploadedPart[] = await request.json();
      const object = await upload.complete(parts);
      return Response.json({ key: object.key, size: object.size, etag: object.etag });
    }
    if (url.pathname === "/abort" && request.method === "POST") {
      await upload.abort();
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
