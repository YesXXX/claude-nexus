import type { UpdatePublicKey } from './update-manifest';

/**
 * 更新清单验签公钥（由 npm run keygen 生成）。
 * 公钥不是秘密，可以提交、打包。支持多把以便轮换：
 * 先发布一个用旧私钥签名、同时内嵌新旧两把公钥的版本，下一个版本再移除旧公钥。
 */
export const UPDATE_PUBLIC_KEYS: UpdatePublicKey[] = [
  {
    keyId: 'c7d7d677d73e756f',
    pem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6cOr/BX0OqEVDW+adGTDfAZZ6HKF4beC2trFZAggT+g=\n-----END PUBLIC KEY-----\n",
  },
];
