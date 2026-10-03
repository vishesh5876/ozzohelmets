export const CUSTOMER_JWT_AUDIENCE = 'helmet-customer';
export const CUSTOMER_REFRESH_COOKIE = 'helmet_customer_rt';
export const CUSTOMER_REFRESH_COOKIE_PATH = '/api/v1/customer/auth';

export interface CustomerJwtPayload {
  sub: string;
  typ: 'customer';
  /** Refresh-token family of the session that minted this token (marks the current session). */
  sid: string;
}

/** Authenticated customer attached to the request by CustomerJwtGuard. Never trust a client-sent user id. */
export interface AuthenticatedCustomer {
  id: string;
  mobile: string | null;
  sessionId: string;
}
