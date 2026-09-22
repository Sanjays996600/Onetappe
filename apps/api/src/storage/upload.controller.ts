import { Controller, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators.js';
import { UnauthorizedError, ValidationError } from '../common/errors.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from './document-storage.js';
import { LocalDocumentStorage } from './local-document-storage.js';

/**
 * Receives document bytes for the local storage provider. The signed token in the URL is
 * the authorisation: it names the single file, its type and size limit, and expires.
 */
@Controller('uploads')
@Public()
export class UploadController {
  constructor(@Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage) {}

  @Put(':token')
  @HttpCode(204)
  async upload(@Param('token') token: string, @Req() request: FastifyRequest): Promise<void> {
    if (!(this.storage instanceof LocalDocumentStorage))
      throw new UnauthorizedError('UPLOAD_INVALID', 'Unknown upload');
    const claims = this.storage.verifyUploadToken(token);
    if (!claims)
      throw new UnauthorizedError(
        'UPLOAD_LINK_INVALID',
        'This upload link is invalid or has expired',
      );
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw new ValidationError('UPLOAD_EMPTY', 'Send the file bytes');
    if (body.length > claims.maxBytes)
      throw new ValidationError('UPLOAD_TOO_LARGE', 'The file is too large');
    try {
      await this.storage.store(claims.key, claims.contentType, body);
    } catch {
      throw new ValidationError('UPLOAD_ALREADY_USED', 'This upload link has already been used');
    }
  }
}
