;; tsx shares the typescript queries
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.type
(internal_module name: (identifier) @name) @definition.namespace
(method_definition name: [(property_identifier) (computed_property_name) (private_property_identifier)] @name) @definition.method
(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)
(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)
(lexical_declaration (variable_declarator name: (identifier) @name) @definition.const)
(variable_declaration (variable_declarator name: (identifier) @name) @definition.const)

;; ---- references ----
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.call
(class_heritage (extends_clause value: (identifier) @name)) @reference.extends
(class_heritage (implements_clause (type_identifier) @name)) @reference.implements
(interface_declaration (extends_type_clause (type_identifier) @name)) @reference.extends
(import_statement) @reference.import
(export_statement source: (string)) @reference.import
(identifier) @reference.ident
(type_identifier) @reference.ident
