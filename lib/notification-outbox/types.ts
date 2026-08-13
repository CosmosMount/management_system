export type NotificationDeliveryClaim = {
  attempts: number;
  lockedUntil: Date;
};

export type NotificationCoordinationTerminalState = {
  status: "CANCELED" | "FAILED";
  lastError: string;
  nextRunAt?: Date;
};

export type DrainNotificationOutboxOptions = {
  ignoreDeliveryDisabled?: boolean;
};
