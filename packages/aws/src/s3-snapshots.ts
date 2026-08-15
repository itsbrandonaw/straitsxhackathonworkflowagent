import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { SnapshotAccess, SnapshotStore } from "@happy/runtime";

export class S3SnapshotStore implements SnapshotStore {
  private readonly client: S3Client;

  constructor(private readonly bucketName: string, options: { region?: string } = {}) {
    this.client = new S3Client(options.region ? { region: options.region } : {});
  }

  async put(input: {
    activityId: string;
    itemId: string;
    scoutId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<string> {
    const extension = input.contentType === "image/svg+xml" ? "svg" : "jpg";
    const key = `snapshots/${input.activityId}/${input.itemId}/${input.scoutId}/${Date.now()}.${extension}`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: input.bytes,
      ContentType: input.contentType,
      ServerSideEncryption: "AES256",
      CacheControl: "no-store"
    }));
    return key;
  }

  async get(key: string): Promise<SnapshotAccess> {
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucketName, Key: key }), {
      expiresIn: 300
    });
    return { kind: "redirect", url };
  }
}
