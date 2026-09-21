import { zodResolver } from '@hookform/resolvers/zod';
import { credentialsSchema, toDisplayMessage, type Credentials } from '@stockdesk/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button, Card, Field, InlineError, Input } from '@/components/ui';
import { supabase } from '@/lib/supabase';

/**
 * ログイン画面。
 *
 * 新規登録もこの画面から行える（小規模ショップでは運営者自身が最初の1人になるため）。
 * 最初に登録したユーザーが owner になるのは DB 側のトリガ handle_new_user() の責務。
 */
export function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setNotice(null);

    const result =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword(values)
        : await supabase.auth.signUp(values);

    if (result.error) {
      setFormError(toDisplayMessage(result.error));
      return;
    }

    // ローカル開発ではメール確認が無効なので即ログインになる。
    // 本番でメール確認を有効にした場合に備えて、セッションが無いケースを案内する。
    if (mode === 'signup' && !result.data.session) {
      setNotice('確認メールを送信しました。メール内のリンクから登録を完了してください。');
    }
  });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">StockDesk</h1>
          <p className="mt-1 text-sm text-slate-500">小規模EC向け バックオフィス管理</p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="メールアドレス" htmlFor="email" error={errors.email?.message} required>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="owner@example.com"
                {...register('email')}
              />
            </Field>

            <Field label="パスワード" htmlFor="password" error={errors.password?.message} required>
              <Input
                id="password"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                {...register('password')}
              />
            </Field>

            <InlineError message={formError} />
            {notice && (
              <p className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700">{notice}</p>
            )}

            <Button type="submit" variant="primary" loading={isSubmitting} className="w-full">
              {mode === 'signin' ? 'ログイン' : '登録する'}
            </Button>
          </form>

          <div className="mt-4 border-t border-slate-200 pt-4 text-center">
            <button
              type="button"
              className="text-sm text-brand-600 hover:underline"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setFormError(null);
                setNotice(null);
              }}
            >
              {mode === 'signin'
                ? 'はじめて利用する（アカウントを作成）'
                : 'すでにアカウントをお持ちの方'}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
