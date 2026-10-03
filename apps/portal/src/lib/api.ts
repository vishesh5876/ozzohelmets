import { createApiClient } from '@helmet/api-client';
import { API_BASE } from './config';

export { ApiError, errorMessage } from '@helmet/api-client';

export const api = createApiClient(API_BASE);
