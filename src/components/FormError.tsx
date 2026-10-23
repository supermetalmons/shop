type FormErrorProps = {
  message: string | null;
  id?: string;
};

export function FormError({ message, id }: FormErrorProps) {
  return message ? <div id={id} className="error" role="alert">{message}</div> : null;
}
