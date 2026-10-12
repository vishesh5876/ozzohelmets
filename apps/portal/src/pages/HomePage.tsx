import { Link } from 'react-router-dom';
import { buttonVariants } from '@helmet/ui';
import { SiteFrame } from './SiteFrame';

export function HomePage() {
  return (
    <SiteFrame>
      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-8 lg:grid-cols-2 lg:py-24">
        <div>
          <h1 className="text-display-xl font-bold sm:text-display-xxl">
            Your Safety ID speaks for you when you can’t.
          </h1>
          <p className="mt-5 max-w-lg text-lg text-body">
            An Ozzo Safety ID is a secure QR code — on your helmet, a sticker or a card. Activate
            it, add your emergency profile, and first responders see exactly what you choose to
            share — nothing more.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/activate" className={buttonVariants({ size: 'lg' })}>
              Activate Safety ID
            </Link>
            <Link to="/login" className={buttonVariants({ variant: 'subtle', size: 'lg' })}>
              Sign in
            </Link>
          </div>
        </div>
        <div className="rounded-xl bg-canvas-soft p-6 sm:p-8">
          <ol className="flex flex-col gap-6">
            {[
              ['Scan', 'Scan the QR code of your Safety ID (on your helmet, sticker or card).'],
              [
                'Activate',
                'Enter the Activation PIN printed with your Safety ID and create a password. Save your Recovery Code.',
              ],
              [
                'Protect',
                'Add blood group, allergies, conditions and emergency contacts. You control what is public.',
              ],
            ].map(([title, body], i) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink font-bold text-on-dark">
                  {i + 1}
                </span>
                <div>
                  <p className="text-display-sm font-bold">{title}</p>
                  <p className="text-body">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section className="bg-ink text-on-dark">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-8 md:grid-cols-3">
          {[
            ['Private by default', 'Nothing appears on your public page until you switch it on.'],
            [
              'Genuine helmets',
              'Each code is unique and cryptographically generated, so counterfeits are easier to spot.',
            ],
            ['Built for emergencies', 'No app, no login and no delay for the person helping you.'],
          ].map(([title, body]) => (
            <div key={title}>
              <p className="text-display-sm font-bold">{title}</p>
              <p className="mt-2 text-mute">{body}</p>
            </div>
          ))}
        </div>
      </section>
    </SiteFrame>
  );
}
