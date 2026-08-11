import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Syntax highlighting that pulls its palette from the app theme's CSS
 * variables on `:root`, so editor text follows whatever theme is active —
 * including the light ones, where CodeMirror's built-in highlight is a default
 * that matches nothing. Colors resolve at render time, so switching themes
 * re-skins the editor with no rebuild.
 */
export const appSyntaxHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.comment, color: "hsl(var(--syntax-comment))" },
    {
      tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.self],
      color: "hsl(var(--syntax-keyword))",
    },
    { tag: [t.string, t.special(t.string), t.character, t.regexp, t.labelName, t.literal],
      color: "hsl(var(--syntax-string))" },
    {
      tag: [t.number, t.integer, t.float, t.bool, t.atom, t.null],
      color: "hsl(var(--syntax-const))",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: "hsl(var(--syntax-function))",
    },
    {
      tag: [t.typeName, t.className, t.namespace],
      color: "hsl(var(--syntax-type))",
    },
    {
      tag: [
        t.variableName,
        t.propertyName,
        t.definition(t.variableName),
        t.definition(t.propertyName),
      ],
      color: "hsl(var(--syntax-variable))",
    },
    { tag: [t.operator, t.definitionOperator], color: "hsl(var(--syntax-operator))" },
    { tag: [t.punctuation, t.separator, t.bracket], color: "hsl(var(--syntax-punctuation))" },
    { tag: [t.tagName, t.meta, t.processingInstruction], color: "hsl(var(--syntax-tag))" },
    { tag: [t.attributeName], color: "hsl(var(--syntax-attribute))" },
  ]),
);