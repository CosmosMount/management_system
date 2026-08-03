export type PickerOption = {
  id: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type PickerPage<TOption extends PickerOption> = {
  items: TOption[];
  nextCursor: string | null;
  hasMoreByQuery?: boolean;
};

export type PickerLoadOptions<TOption extends PickerOption> = (input: {
  query: string;
  cursor?: string;
}) => Promise<PickerPage<TOption>>;

export type PickerResolveOptions<TOption extends PickerOption> = (
  ids: string[],
) => Promise<TOption[]>;
