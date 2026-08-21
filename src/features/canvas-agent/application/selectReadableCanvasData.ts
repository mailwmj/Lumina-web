export function selectReadableCanvasData(
  data: Record<string, unknown>,
  readableFields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(readableFields.flatMap((field) => (
    Object.prototype.hasOwnProperty.call(data, field) ? [[field, data[field]]] : []
  )));
}
