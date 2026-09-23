import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from './document-storage.js';
import { DocumentService } from './document.service.js';
import { LocalDocumentStorage } from './local-document-storage.js';
import {
  ClamdScanner,
  MALWARE_SCANNER,
  NoScanner,
  type MalwareScanner,
} from './malware-scanner.js';
import { S3DocumentStorage } from './s3-document-storage.js';
import { UploadController } from './upload.controller.js';

@Global()
@Module({
  controllers: [UploadController],
  providers: [
    {
      provide: DOCUMENT_STORAGE,
      inject: [ENV],
      useFactory: (env: Env): DocumentStorage =>
        env.STORAGE_PROVIDER === 's3'
          ? new S3DocumentStorage({
              bucket: env.S3_BUCKET ?? '',
              region: env.S3_REGION,
              ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
              ...(env.S3_KMS_KEY_ID ? { kmsKeyId: env.S3_KMS_KEY_ID } : {}),
            })
          : new LocalDocumentStorage(env.STORAGE_DIR, env.DATA_ENCRYPTION_KEY, env.PUBLIC_API_URL),
    },
    {
      provide: MALWARE_SCANNER,
      inject: [ENV],
      useFactory: (env: Env): MalwareScanner =>
        env.MALWARE_SCANNER === 'clamav'
          ? new ClamdScanner(env.CLAMAV_HOST, env.CLAMAV_PORT)
          : new NoScanner(),
    },
    DocumentService,
  ],
  exports: [DOCUMENT_STORAGE, MALWARE_SCANNER, DocumentService],
})
export class StorageModule {}
