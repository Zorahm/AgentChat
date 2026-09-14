/** Onboarding wizard — wraps automated EnvironmentSetup. */

import { EnvironmentSetup, type EnvironmentSetupProps } from "./EnvironmentSetup";

export type OnboardingWizardProps = EnvironmentSetupProps;

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  return <EnvironmentSetup onComplete={onComplete} />;
}
