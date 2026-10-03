import { PageTitle } from '../../components/AppLayout';
import { ContactsManager } from './ContactsManager';
import { EnableProfileCard } from './EnableProfileCard';
import { ProfileForm } from './ProfileForm';
import { PublicPreview } from './PublicPreview';
import { VisibilityForm } from './VisibilityForm';

export function ProfilePage() {
  return (
    <div className="max-w-2xl">
      <PageTitle
        title="Emergency details"
        description="Changes are saved securely; only what you allow in Privacy is ever public."
      />
      <ProfileForm />
    </div>
  );
}

export function ContactsPage() {
  return (
    <div className="max-w-2xl">
      <PageTitle
        title="Emergency contacts"
        description="Up to five people, called in this order."
      />
      <ContactsManager />
    </div>
  );
}

export function PrivacyPage() {
  return (
    <>
      <PageTitle
        title="Privacy"
        description="You decide what appears when someone scans your helmet."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <EnableProfileCard />
          <VisibilityForm />
        </div>
        <div>
          <h2 className="mb-3 text-display-sm font-bold">Public page preview</h2>
          <PublicPreview />
        </div>
      </div>
    </>
  );
}
