(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
(expression_statement (assignment left: (identifier) @name)) @definition.const
(call function: (identifier) @name) @reference.call
(call function: (attribute attribute: (identifier) @name)) @reference.call
(class_definition superclasses: (argument_list (identifier) @name)) @reference.extends
(import_statement) @reference.import
(import_from_statement) @reference.import
(identifier) @reference.ident
