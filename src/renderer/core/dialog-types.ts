import type { NotificationPayload } from '../../shared/types';

/**
 * 提示与对话框的参数类型。实现在 ui 层，类型放在 core，
 * 这样 AppContext 能描述 toast / confirm / choice 的签名而不必让 core 依赖 ui。
 */

export type ToastLevel = NotificationPayload['level'];

export interface ConfirmOptions {
  title: string;
  message: string;
  okText: string;
  /** 破坏性操作：确认按钮用红色 */
  danger?: boolean;
}

export interface DialogChoice<T extends string> {
  value: T;
  text: string;
  /** primary 白色主按钮；danger 红色；缺省为普通按钮 */
  style?: 'primary' | 'danger';
}

export interface ChoiceOptions<T extends string> {
  title: string;
  message: string;
  choices: Array<DialogChoice<T>>;
  danger?: boolean;
  /** 默认获得焦点的选项；缺省时焦点在「取消」，用于回车即执行安全操作（如排队）的场合 */
  defaultValue?: T;
}
