import { env } from "@/env";
import {
  hasAppleOauthConfig,
  hasGoogleOauthConfig,
  hasMicrosoftOauthConfig,
} from "@/utils/oauth/provider-config";

export type LoginProvider =
  | "google"
  | "microsoft"
  | "apple"
  | "sso"
  | "password"
  | "redirect-sso";

export function getEnabledLoginProviders(
  inputs: {
    hasGoogleConfig?: boolean;
    hasMicrosoftConfig?: boolean;
    hasAppleConfig?: boolean;
    ssoLoginEnabled?: boolean;
    passwordLoginEnabled?: boolean;
    redirectSsoEnabled?: boolean;
  } = {},
): ReadonlySet<LoginProvider> {
  const {
    hasGoogleConfig = hasGoogleOauthConfig(),
    hasMicrosoftConfig = hasMicrosoftOauthConfig(),
    hasAppleConfig = hasAppleOauthConfig(),
    ssoLoginEnabled = env.SSO_LOGIN_ENABLED,
    passwordLoginEnabled = env.PASSWORD_LOGIN_ENABLED,
    redirectSsoEnabled = !!env.REDIRECT_SSO_URL,
  } = inputs;

  const enabled = new Set<LoginProvider>();

  if (hasGoogleConfig) {
    enabled.add("google");
  }
  if (hasMicrosoftConfig) {
    enabled.add("microsoft");
  }
  if (hasAppleConfig) {
    enabled.add("apple");
  }
  if (ssoLoginEnabled) {
    enabled.add("sso");
  }
  if (passwordLoginEnabled) {
    enabled.add("password");
  }
  if (redirectSsoEnabled) {
    enabled.add("redirect-sso");
  }

  return enabled;
}
