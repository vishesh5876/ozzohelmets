import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'http:raw-response';

/** Skip the `{ success, data }` envelope (files, images, CSV streams). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
