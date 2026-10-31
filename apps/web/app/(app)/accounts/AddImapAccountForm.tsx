"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastError, toastSuccess } from "@/components/Toast";
import { MutedText } from "@/components/Typography";
import { getActionErrorMessage } from "@/utils/error";
import {
  connectImapAccountAction,
  testImapConnectionAction,
} from "@/utils/actions/imap";
import {
  type ImapConnectionBody,
  imapConnectionBody,
} from "@/utils/actions/imap.validation";
import {
  findImapPresetForEmail,
  getImapPreset,
  IMAP_PRESETS,
  type ImapPreset,
} from "@/utils/imap/presets";

const CUSTOM_PRESET = "custom";

export function AddImapAccountForm({
  onConnected,
}: {
  onConnected: (emailAccountId: string) => void;
}) {
  const [presetId, setPresetId] = useState<string>(IMAP_PRESETS[0].id);
  const [testMessage, setTestMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const preset = getImapPreset(presetId);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    watch,
    formState: { errors },
  } = useForm<ImapConnectionBody>({
    resolver: zodResolver(imapConnectionBody),
    defaultValues: {
      email: "",
      username: "",
      password: "",
      ...serverFields(IMAP_PRESETS[0]),
    },
  });

  const testAction = useAction(testImapConnectionAction, {
    onSuccess: ({ data }) => {
      if (!data) return;
      setTestMessage(
        data.ok
          ? {
              ok: true,
              text: `Connected. Found ${data.folderCount} folders${formatRoles(data.folders)}.`,
            }
          : { ok: false, text: `${stageLabel(data.stage)}: ${data.error}` },
      );
    },
    onError: ({ error }) =>
      setTestMessage({ ok: false, text: getActionErrorMessage(error) }),
  });

  const connectAction = useAction(connectImapAccountAction, {
    onSuccess: ({ data }) => {
      if (!data) return;
      toastSuccess({ description: "Mailbox connected." });
      onConnected(data.emailAccountId);
    },
    onError: ({ error }) =>
      toastError({
        title: "Could not connect mailbox",
        description: getActionErrorMessage(error),
      }),
  });

  const applyPreset = (id: string) => {
    setPresetId(id);
    const next = getImapPreset(id);
    if (!next) return;
    for (const [key, value] of Object.entries(serverFields(next))) {
      setValue(key as keyof ImapConnectionBody, value as never);
    }
  };

  const onEmailBlur = () => {
    const email = getValues("email").trim();
    if (!getValues("username")) setValue("username", email);
    const detected = findImapPresetForEmail(email);
    if (detected && detected.id !== presetId) applyPreset(detected.id);
  };

  const busy = testAction.isPending || connectAction.isPending;

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit((values) => connectAction.execute(values))}
    >
      <div className="space-y-2">
        <Label>Provider</Label>
        <Select value={presetId} onValueChange={applyPreset}>
          <SelectTrigger aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {IMAP_PRESETS.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_PRESET}>Other IMAP server</SelectItem>
          </SelectContent>
        </Select>
        {preset && <MutedText>{preset.passwordHint}</MutedText>}
      </div>

      <Field label="Email address" error={errors.email?.message}>
        <Input
          type="email"
          autoComplete="email"
          {...register("email", { onBlur: onEmailBlur })}
        />
      </Field>
      <Field label="Username" error={errors.username?.message}>
        <Input autoComplete="username" {...register("username")} />
      </Field>
      <Field
        label="Password / app password / authorization code"
        error={errors.password?.message}
      >
        <Input
          type="password"
          autoComplete="current-password"
          {...register("password")}
        />
      </Field>

      <details open={presetId === CUSTOM_PRESET}>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Server settings
        </summary>
        <div className="mt-3 grid grid-cols-[1fr_6rem_7rem] gap-2">
          <ServerRow
            prefix="imap"
            label="IMAP"
            register={register}
            security={watch("imapSecurity")}
            onSecurityChange={(value) => setValue("imapSecurity", value)}
          />
          <ServerRow
            prefix="smtp"
            label="SMTP"
            register={register}
            security={watch("smtpSecurity")}
            onSecurityChange={(value) => setValue("smtpSecurity", value)}
          />
        </div>
        {(errors.imapHost || errors.smtpHost) && (
          <p className="mt-1 text-sm text-destructive">
            {errors.imapHost?.message || errors.smtpHost?.message}
          </p>
        )}
      </details>

      {testMessage && (
        <p
          role="status"
          className={
            testMessage.ok
              ? "text-sm text-green-600"
              : "text-sm text-destructive"
          }
        >
          {testMessage.text}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          loading={testAction.isPending}
          disabled={busy}
          onClick={handleSubmit((values) => {
            setTestMessage(null);
            testAction.execute(values);
          })}
        >
          Test connection
        </Button>
        <Button type="submit" loading={connectAction.isPending} disabled={busy}>
          Connect
        </Button>
      </div>
    </form>
  );
}

function ServerRow({
  prefix,
  label,
  register,
  security,
  onSecurityChange,
}: {
  prefix: "imap" | "smtp";
  label: string;
  register: ReturnType<typeof useForm<ImapConnectionBody>>["register"];
  security: "tls" | "starttls";
  onSecurityChange: (value: "tls" | "starttls") => void;
}) {
  return (
    <>
      <Input
        aria-label={`${label} host`}
        placeholder={`${label} host`}
        {...register(`${prefix}Host`)}
      />
      <Input
        aria-label={`${label} port`}
        type="number"
        {...register(`${prefix}Port`, { valueAsNumber: true })}
      />
      <Select
        value={security}
        onValueChange={(value) => onSecurityChange(value as "tls" | "starttls")}
      >
        <SelectTrigger aria-label={`${label} security`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tls">SSL/TLS</SelectItem>
          <SelectItem value="starttls">STARTTLS</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="flex flex-col items-start gap-1">
        {label}
        {children}
      </Label>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function serverFields(preset: ImapPreset) {
  return {
    imapHost: preset.imapHost,
    imapPort: preset.imapPort,
    imapSecurity: preset.imapSecurity,
    smtpHost: preset.smtpHost,
    smtpPort: preset.smtpPort,
    smtpSecurity: preset.smtpSecurity,
  };
}

function formatRoles(folders: Partial<Record<string, string>>) {
  const roles = ["sent", "drafts", "trash", "junk", "archive"].filter(
    (role) => folders[role],
  );
  return roles.length ? ` (${roles.join(", ")} detected)` : "";
}

function stageLabel(stage: "host" | "imap" | "smtp") {
  if (stage === "imap") return "IMAP";
  if (stage === "smtp") return "SMTP";
  return "Server";
}
