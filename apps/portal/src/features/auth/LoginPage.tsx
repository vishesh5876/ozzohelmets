import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@helmet/ui';
import { useCustomerAuth } from '../../lib/auth-context';
import { SiteFrame } from '../../pages/SiteFrame';
import { PhoneOtpForm } from './PhoneOtpForm';
import { safeNext } from './safe-next';

export function LoginPage() {
  const { status, signIn } = useCustomerAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  if (status === 'authenticated') return <Navigate to={next} replace />;

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
        <h1 className="text-display-lg font-bold">Sign in</h1>
        <p className="mt-2 text-body">
          Use the mobile number linked to your helmet. New here? An account is created after you
          verify.
        </p>
        <Card className="mt-8">
          <CardContent>
            <PhoneOtpForm
              onVerified={(session) => {
                signIn(session);
                navigate(next, { replace: true });
              }}
            />
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
